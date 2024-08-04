import { formatEther, Interface, JsonRpcProvider, toBigInt } from "ethers";
import SpokeConnectorABI from "./abis/SpokeConnector.json";
import { gql, GraphQLClient } from "graphql-request";
import axios from "axios";
import { createWriteStream, existsSync, readFileSync } from "fs";
import reconciledtxs from "./input.json";

const spokeConectorInterface = new Interface(SpokeConnectorABI);
const uniswapV2SubgraphEndpoint = "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v2";
const uniswapGraphQLClient = new GraphQLClient(uniswapV2SubgraphEndpoint);


const defaultChainConfigs = {
    "1": { rpc: "https://cloudflare-eth.com", mainnetEquivalent: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", stable: false },
    "10": { rpc: "https://endpoints.omniatech.io/v1/op/mainnet/public", mainnetEquivalent: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", stable: false },
    "56": { rpc: "https://bsc-dataseed2.ninicoin.io", mainnetEquivalent: "0xB8c77482e45F1F44dE1745F52C74426C631bDD52", stable: false },
    "100": { rpc: "https://rpc.gnosischain.com", mainnetEquivalent: "0x6B175474E89094C44Da98b954EedeAC495271d0F", stable: true },
    "137": { rpc: "https://polygon.llamarpc.com", mainnetEquivalent: "0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0", stable: false },
    "42161": { rpc: "https://endpoints.omniatech.io/v1/arbitrum/one/public", mainnetEquivalent: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", stable: false },
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
  }> => {
    const { rpc, mainnetEquivalent, stable } = chainInfo;
    const provider = new JsonRpcProvider(rpc);
    const receipt = await provider.getTransactionReceipt(txHash);
    console.log(receipt);
    const gasUsed = receipt.gasUsed.toString();
    const gasPrice = receipt.gasPrice.toString();
  
    const parsedLogs = receipt.logs
      .map((log: any) => {
        return {
          spokeConnector: spokeConectorInterface.parseLog(log),
        };
      })
      .filter((i) => i.spokeConnector);
  
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
    // console.log({ rpc, txHash, parsedLogs, flattenParsedLogs });
    const eventNames = flattenParsedLogs.length > 0 ? flattenParsedLogs : "NoEvents";
  
    // const tokenPrice = await getTokenPrice(chainId, mainnetEquivalent, timestamp, receipt.blockNumber);
    const tokenPrice = 1;
  
    let feeInEth = (receipt.gasUsed * receipt.gasPrice).toString();
    if (chainId === 10) {
      const { l1Fee } = await getl1TxInfo(chainId, txHash);
      feeInEth = (toBigInt(feeInEth) + toBigInt(l1Fee)).toString();
    }
    const feeInUsd = formatEther((toBigInt(feeInEth) * toBigInt(Math.floor(tokenPrice * 1000))) / toBigInt(1000));
  
    console.log({ timestamp, gasUsed, gasPrice, tokenPrice, feeInUsd, feeInEth});
  
    return { evtNames: eventNames, gasUsed, gasPrice, ethPrice: tokenPrice.toFixed(3), feeInEth, feeInUsd};
  };

const parseSpokeConnector = async () => {
    const chainId = process.argv[2];
    const spokeconnector = process.argv[3];
    console.log({ chainId, spokeconnector });
    if (!chainId) {
      console.log("Missing chainId");
    }
    if (!spokeconnector) {
      console.log("Missing spoke connector address");
    }
  
    console.log(`[x] Reading rpc providers from config.json...`);
  
    console.log(`[x] Reading rpc providers from config.json DONE! rpcProviders: ${defaultChainConfigs[chainId]}`);
  
    const dataLogger = createWriteStream(`analytics-spokeconnector.csv`, { flags: "a" }); // append mode
  
    // If you handle lots of calls in parallel against public rpcs, it could throw due to its limited rate.
    // It would be fine to process rpc calls step by step as of now
    for (let idx = 0; idx < reconciledtxs.length; idx++) {
      if (idx === 0) {
        dataLogger.write(
          `index,time,chainId,txhash,gasUsed,gasPrice,ethPrice,batchSize\n`
        );
      }

      const txHash = reconciledtxs[idx].txhash;
      // 2023-02-06 05:40:56.016399,42161,0x32c2631d5bc88e78105edf7543158689720d2f4de969b79b946f16c83e629e21,0x64e54a6a771267b35a40dc14cf80921a6afb05990d086186b2d2f9c591087d92,296903,$0.30
      try {
        console.log(`Ananlyzing item${idx}...`);
        const { evtNames, gasUsed, gasPrice, ethPrice, feeInEth, feeInUsd } = await parseLogs(
          +chainId,
          defaultChainConfigs[chainId],
          reconciledtxs[idx].txhash,
          Math.floor(new Date().getTime() / 1000) // No need an exact value
        );
        const newLine = `${idx},${new Date().getTime() / 1000},${chainId},${reconciledtxs[idx].txhash},${gasUsed},${gasPrice},${ethPrice},${reconciledtxs[idx].count}\n`;
        dataLogger.write(newLine);
      } catch (e: unknown) {
        console.log(`Unknown error. chainId: ${chainId}, txHash: ${txHash}`);
        console.log("message: ", (e as any).message);
        console.log(e);
  
        process.exit(1);
      }
    }

    console.log(`app end`);
  };

  parseSpokeConnector();