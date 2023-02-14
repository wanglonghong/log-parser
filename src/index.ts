import { formatEther, Interface, JsonRpcProvider, toBigInt } from "ethers";
import { createWriteStream, existsSync, readFileSync } from "fs";
import ConnextABI from "./abis/Connext.json";
import SpokeConnectorABI from "./abis/SpokeConnector.json";
import HubConnectorABI from "./abis/HubConnector.json";
import RootManagerABI from "./abis/RootManager.json";
import { gql, GraphQLClient } from "graphql-request";
import axios from "axios";

const connextInterface = new Interface(ConnextABI);
const spokeConectorInterface = new Interface(SpokeConnectorABI);
const hubConnectorInterface = new Interface(HubConnectorABI);
const rootManagerInterface = new Interface(RootManagerABI);

const uniswapV2SubgraphEndpoint = "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v2";
const uniswapGraphQLClient = new GraphQLClient(uniswapV2SubgraphEndpoint);

const defaultChainConfigs = {
  "1": { rpc: "https://cloudflare-eth.com", mainnetEquivalent: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", stable: false },
  "10": { rpc: "https://mainnet.optimism.io", mainnetEquivalent: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", stable: false },
  "56": { rpc: "https://bsc-dataseed2.ninicoin.io", mainnetEquivalent: "0xB8c77482e45F1F44dE1745F52C74426C631bDD52", stable: false },
  "100": { rpc: "https://rpc.gnosischain.com", mainnetEquivalent: "0x6B175474E89094C44Da98b954EedeAC495271d0F", stable: true },
  "137": { rpc: "https://polygon.llamarpc.com", mainnetEquivalent: "0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0", stable: false },
  "42161": { rpc: "https://endpoints.omniatech.io/v1/arbitrum/one/public", mainnetEquivalent: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", stable: false },
};

// curl -X POST -H "Origin: https://pancakeswap.finance" -d '{"query" : " query tokenPriceData { bundle (id: \"1\", block: {number: 25634027}) { bnbPrice }}"}' https://proxy-worker.pancake-swap.workers.dev/bsc-exchange
const getBNBPrice = async (blockNumber: number): Promise<number> => {
  try {
    const workerEndpoint = "https://proxy-worker.pancake-swap.workers.dev/bsc-exchange";
    const headers = {
      "Content-Type": "application/json",
      Origin: "https://pancakeswap.finance",
    };
    const data = { query: ` query tokenPriceData { bundle (id: \"1\", block: {number: ${blockNumber}}) { bnbPrice }}` };

    const res = await axios.post(workerEndpoint, data, { headers });
    return Number(res.data.data.bundle.bnbPrice);
  } catch (e: unknown) {
    return 0;
  }
};

const getTokenPrice = async (chainId: number, mainnetEquivalent: string, timestamp: number, blockNumber: number): Promise<number> => {
  if (chainId == 56) {
    const tokenPrice = await getBNBPrice(blockNumber);
    return tokenPrice;
  }

  const queryStr = `tokenDayDatas (first: 1, where: {token: "${mainnetEquivalent.toLowerCase()}", date_lte: ${timestamp}}, orderBy: date, orderDirection: desc ) { priceUSD }`;
  const gqlQuery = gql`
            query GetTokenDayDatas {
                ${queryStr}
            }
        `;

  const result = await uniswapGraphQLClient.request(gqlQuery);
  const tokenPrice = result.tokenDayDatas.length > 0 ? Number(result.tokenDayDatas[0].priceUSD) : 0;

  return tokenPrice;
};

const getTransferInfo = async (
  eventNames: string,
  executeTxHash: string
): Promise<{ originChain: number; originEthPrice: number; relayerFee: string; relayerFeeInUsd: number }> => {
  const filterKey = "connext:Executed";
  if (eventNames.includes(filterKey)) {
    const endpoint = `https://postgrest.mainnet.connext.ninja/transfers?execute_transaction_hash=eq.${executeTxHash}&select=origin_chain,xcall_block_number,xcall_timestamp,execute_transaction_hash,relayer_fee&limit=1&offset=0`;
    const res = await axios.get(endpoint);
    const data = res.data[0];
    const originChain = Number(data.origin_chain);
    const xcall_block_number = Number(data.xcall_block_number);
    const xcall_timestamp = Number(data.xcall_timestamp);
    const mainnetEquivalent = defaultChainConfigs[originChain.toString()]!.mainnetEquivalent;
    const relayerFee = data.relayer_fee;

    const originTokenPrice = await getTokenPrice(originChain, mainnetEquivalent, xcall_timestamp, xcall_block_number);
    const relayerFeeInUsd = Number(formatEther(toBigInt(relayerFee) * toBigInt(Math.floor(originTokenPrice * 1000)))) / 1000;
    return { originChain: Number(data.origin_chain), relayerFee: data.relayer_fee, originEthPrice: originTokenPrice, relayerFeeInUsd };
  } else {
    return { originChain: 0, originEthPrice: 0, relayerFee: "0", relayerFeeInUsd: 0 };
  }
};

const getl1TxInfo = async (chainId: number, l2TxHash: string): Promise<{ l1Fee: string }> => {
  if (chainId !== 10) throw new Error("Only supported optimism txs");

  const url = defaultChainConfigs[chainId.toString()].rpc;
  const data = {
    jsonrpc: "2.0",
    method: "eth_getTransactionReceipt",
    params: [`${l2TxHash}`],
    id: 1,
  };
  // "l1Fee":"0x1720834bb33830","l1FeeScalar":"1","l1GasPrice":"0x1f8809c6cc","l1GasUsed":"0xbbc4"
  // l1Fee: 6509672747186224
  // l1FeeScalar: 1
  // l1GasPrice: 135426328268
  // l1GasUsed: 48068
  const res = await axios.post(url, data);
  const { l1Fee, l1FeeScalar } = res.data.result;
  return { l1Fee: (toBigInt(l1Fee) * toBigInt(l1FeeScalar)).toString() };
};
// Returns all the event names from the `txHash`
const parseLogs = async (
  chainId: number,
  chainInfo: any,
  txHash: string,
  timestamp: number
): Promise<{
  evtNames: string;
  gasUsed: string;
  gasPrice: string;
  ethPrice: string;
  feeInEth: string;
  feeInUsd: string;
  originChain: number;
  originEthPrice: number;
  relayerFee: string;
  relayerFeeInUsd: number;
}> => {
  const { rpc, mainnetEquivalent, stable } = chainInfo;
  const provider = new JsonRpcProvider(rpc);
  console.log(await provider.getTransaction(txHash));

  const receipt = await provider.getTransactionReceipt(txHash);
  console.log(receipt);
  const gasUsed = receipt.gasUsed.toString();
  const gasPrice = receipt.gasPrice.toString();

  const parsedLogs = receipt.logs
    .map((log: any) => {
      return {
        connext: connextInterface.parseLog(log),
        spokeConnector: spokeConectorInterface.parseLog(log),
        hubConnector: hubConnectorInterface.parseLog(log),
        rootManager: rootManagerInterface.parseLog(log),
      };
    })
    .filter((i) => i.connext || i.spokeConnector || i.hubConnector || i.rootManager);

  let flattenParsedLogs = "";
  for (const parsedLog of parsedLogs) {
    const keys = Object.keys(parsedLog);
    for (const key of keys) {
      if (!parsedLog[key]) continue;
      if (flattenParsedLogs.length == 0) {
        flattenParsedLogs = `${key}:${parsedLog[key].name}`;
      } else {
        flattenParsedLogs = `${flattenParsedLogs}->${key}:${parsedLog[key].name}`;
      }
    }
  }
  console.log({ rpc, txHash, parsedLogs, flattenParsedLogs });
  const eventNames = flattenParsedLogs.length > 0 ? flattenParsedLogs : "NoEvents";

  const tokenPrice = await getTokenPrice(chainId, mainnetEquivalent, timestamp, receipt.blockNumber);

  let feeInEth = (receipt.gasUsed * receipt.gasPrice).toString();
  if (chainId === 10) {
    const { l1Fee } = await getl1TxInfo(chainId, txHash);
    feeInEth = (toBigInt(feeInEth) + toBigInt(l1Fee)).toString();
  }
  const feeInUsd = formatEther((toBigInt(feeInEth) * toBigInt(Math.floor(tokenPrice * 1000))) / toBigInt(1000));

  const transferInfo = await getTransferInfo(eventNames, txHash);
  console.log({ timestamp, gasUsed, gasPrice, tokenPrice, feeInUsd, feeInEth, transferInfo });

  return { evtNames: eventNames, gasUsed, gasPrice, ethPrice: tokenPrice.toFixed(3), feeInEth, feeInUsd, ...transferInfo };
};

const main = async () => {
  const chainId = process.argv[2];
  const filename = process.argv[3];
  console.log({ chainId, filename });
  if (!chainId) {
    console.log("Missing chainId");
  }
  if (!filename) {
    console.log("Missing filename");
  }

  console.log(`[x] Reading rpc providers from config.json...`);

  console.log(`[x] Reading rpc providers from config.json DONE! rpcProviders: ${defaultChainConfigs[chainId]}`);
  const chainIds = [chainId];

  console.log(`[x] Reading raw data from data.csv...`);
  const rawData = readFileSync("data.csv", { encoding: "utf-8" });
  const lines = rawData.split("\n").filter((line) => {
    const items = line.split(",");
    if (typeof items[1] == "string" && chainIds.includes(items[1])) {
      return true;
    }
    return false;
  });
  console.log(`[x] Reading raw data from data.csv DONE! length: ${lines.length}`);
  console.log(`[x] Reading metadata.json...`);
  let readCount = 0;
  try {
    let json: string;
    const path = "metadata.json";
    if (existsSync(path)) {
      json = readFileSync(path, { encoding: "utf-8" });
      readCount = JSON.parse(json).readCount;
    }
  } catch (e: unknown) {
    console.error("Error reading metadata file");
    readCount = 0;
  }

  console.log(`[x] Reading metadata.json DONE! readCount: ${readCount}`);

  const dataLogger = createWriteStream(`${filename}`, { flags: "a" }); // append mode

  const totalCount = lines.length;
  // If you handle lots of calls in parallel against public rpcs, it could throw due to its limited rate.
  // It would be fine to process rpc calls step by step as of now
  for (let idx = readCount; idx < totalCount; idx++) {
    if (idx === 0) {
      dataLogger.write(
        `index,time,chainId,txhash,taskId,spentAmount,spentAmount(USD),events,gasUsed,gasPrice,ethPrice,feeInETH,feeInUsd,originChain,originEthPrice,relayerFee,relayerFeeInUsd\n`
      );
    }
    // 2023-02-06 05:40:56.016399,42161,0x32c2631d5bc88e78105edf7543158689720d2f4de969b79b946f16c83e629e21,0x64e54a6a771267b35a40dc14cf80921a6afb05990d086186b2d2f9c591087d92,296903,$0.30
    const line = lines[idx];
    const items = line.split(",");
    try {
      console.log(`Ananlyzing item${idx}...`);
      const { evtNames, gasUsed, gasPrice, ethPrice, feeInEth, feeInUsd, originChain, originEthPrice, relayerFee, relayerFeeInUsd } = await parseLogs(
        Number(items[1]),
        defaultChainConfigs[items[1]],
        items[2],
        Math.floor(new Date(items[0]).getTime() / 1000)
      );
      const newLine = `${readCount},${line.replace(
        /\n/g,
        ""
      )},${evtNames},${gasUsed},${gasPrice},${ethPrice},${feeInEth},${feeInUsd},${originChain},${originEthPrice},${relayerFee},${relayerFeeInUsd}\n`;
      dataLogger.write(newLine);
      readCount++;
    } catch (e: unknown) {
      console.log(`Unknown error. chainId: ${items[1]}, txHash: ${items[2]}`);
      console.log("message: ", (e as any).message);
      console.log(e);

      process.exit(1);
    }
  }
  const metaDataLogger = createWriteStream("./metadata.json", { flags: "w" }); // write mode
  // metaDataLogger.write(JSON.stringify({ readCount }));
  console.log(`total count: ${totalCount}, readCount: ${readCount}`);
  console.log(`app end`);
};

main();
