import { formatEther, Interface, JsonRpcProvider, toBigInt } from "ethers";
import { createWriteStream, existsSync, readFileSync } from "fs";
import ConnextABI from "./abis/Connext.json";
import SpokeConnectorABI from "./abis/SpokeConnector.json";
import HubConnectorABI from "./abis/HubConnector.json";
import RootManagerABI from "./abis/RootManager.json";
import { gql, GraphQLClient } from "graphql-request";

const connextInterface = new Interface(ConnextABI);
const spokeConectorInterface = new Interface(SpokeConnectorABI);
const hubConnectorInterface = new Interface(HubConnectorABI);
const rootManagerInterface = new Interface(RootManagerABI);

const uniswapV2SubgraphEndpoint = "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v2";
const graphQLClient = new GraphQLClient(uniswapV2SubgraphEndpoint);

// Returns all the event names from the `txHash`
const parseLogs = async (
  chainInfo: any,
  txHash: string,
  timestamp: number
): Promise<{ evtNames: string; gasUsed: string; gasPrice: string; ethPrice: string; feeInEth: string; feeInUsd: string }> => {
  const { rpc, mainnetEquivalent, stable } = chainInfo;
  const provider = new JsonRpcProvider(rpc);
  const receipt = await provider.getTransactionReceipt(txHash);
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

  const queryStr = `tokenDayDatas (first: 1, where: {token: "${(
    mainnetEquivalent as string
  ).toLowerCase()}", date_lte: ${timestamp}}, orderBy: date, orderDirection: desc ) { priceUSD }`;
  const gqlQuery = gql`
        query GetTokenDayDatas {
            ${queryStr}
        }
    `;

  const result = await graphQLClient.request(gqlQuery);
  const tokenPrice = result.tokenDayDatas.length > 0 ? Number(result.tokenDayDatas[0].priceUSD) : 0;
  const feeInUsd = formatEther((receipt.gasUsed * receipt.gasPrice * toBigInt(Math.floor(tokenPrice * 1000))) / toBigInt(1000));
  const feeInEth = (receipt.gasUsed * receipt.gasPrice).toString();
  console.log({ timestamp, gasUsed, gasPrice, tokenPrice, feeInUsd, feeInEth });

  return { evtNames: eventNames, gasUsed, gasPrice, ethPrice: tokenPrice.toFixed(3), feeInEth, feeInUsd };
};

const main = async () => {
  console.log(`[x] Reading rpc providers from config.json...`);
  let rpcProviders: any = {};
  try {
    let json: string;
    const path = "config.json";
    if (existsSync(path)) {
      json = readFileSync(path, { encoding: "utf-8" });
      rpcProviders = JSON.parse(json);
    }
  } catch (e: unknown) {
    console.error("Error reading config file");
    process.exit(1);
  }
  console.log(`[x] Reading rpc providers from config.json DONE! rpcProviders: ${rpcProviders}`);
  const chainIds = Object.keys(rpcProviders);

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

  const dataLogger = createWriteStream("./analytics.csv", { flags: "a" }); // append mode

  const totalCount = lines.length;
  // If you handle lots of calls in parallel against public rpcs, it could throw due to its limited rate.
  // It would be fine to process rpc calls step by step as of now
  for (let idx = readCount; idx < totalCount; idx++) {
    if (idx === 0) {
        dataLogger.write(`index,time,chainId,txhash,taskId,spentAmount,spentAmount(USD),events,gasUsed,gasPrice,ethPrice,feeInETH,feeInUsd\n`);
    }
    // 2023-02-06 05:40:56.016399,42161,0x32c2631d5bc88e78105edf7543158689720d2f4de969b79b946f16c83e629e21,0x64e54a6a771267b35a40dc14cf80921a6afb05990d086186b2d2f9c591087d92,296903,$0.30
    const line = lines[idx];
    const items = line.split(",");
    try {
        console.log(`Ananlyzing item${idx}...`);
      const {evtNames, gasUsed, gasPrice, ethPrice, feeInEth, feeInUsd} = await parseLogs(rpcProviders[items[1]], items[2], Math.floor(new Date(items[0]).getTime() / 1000));
      const newLine = `${readCount},${line},${evtNames},${gasUsed},${gasPrice},${ethPrice},${feeInEth},${feeInUsd}\n`;
      dataLogger.write(newLine);
      readCount++;
    } catch (e: unknown) {
      console.log(`Unknown error. chainId: ${items[1]}, txHash: ${items[2]}`);
      console.log(e);
      process.exit(1);
    }
  }
  const metaDataLogger = createWriteStream("./metadata.json", { flags: "w" }); // write mode
  metaDataLogger.write(JSON.stringify({ readCount }));
  console.log(`total count: ${totalCount}, readCount: ${readCount}`);
  console.log(`app end`);
};

main();
