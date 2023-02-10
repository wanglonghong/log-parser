import { Interface, JsonRpcProvider } from "ethers";
import { createWriteStream, existsSync, readFileSync } from "fs";
import ConnextABI from "./abis/Connext.json";
import SpokeConnectorABI from "./abis/SpokeConnector.json";
import HubConnectorABI from "./abis/HubConnector.json";
import RootManagerABI from "./abis/RootManager.json";

const connextInterface = new Interface(ConnextABI);
const spokeConectorInterface = new Interface(SpokeConnectorABI);
const hubConnectorInterface = new Interface(HubConnectorABI);
const rootManagerInterface = new Interface(RootManagerABI);

// Returns all the event names from the `txHash`
const parseLogs = async (rpcUrl: string, txHash: string): Promise<string> => {
  const provider = new JsonRpcProvider(rpcUrl);
  const receipt = await provider.getTransactionReceipt(txHash);
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
  console.log({ parsedLogs, flattenParsedLogs });
  return flattenParsedLogs.length > 0 ? flattenParsedLogs : "NoEvents";
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
  console.log("Rpc providers: ");
  console.log(rpcProviders);
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
  console.log(`The length of lines: `, lines.length);

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

  const dataLogger = createWriteStream("./analytics.csv", { flags: "a" }); // append mode

  const totalCount = lines.length;
  try {
    // If you handle lots of calls in parallel against public rpcs, it could throw due to its limited rate.
    // It would be fine to process rpc calls step by step as of now
    for (let idx = readCount; idx < totalCount; idx++) {
      // 2023-02-06 05:40:56.016399,42161,0x32c2631d5bc88e78105edf7543158689720d2f4de969b79b946f16c83e629e21,0x64e54a6a771267b35a40dc14cf80921a6afb05990d086186b2d2f9c591087d92,296903,$0.30
      const line = lines[idx];
      const items = line.split(",");
      const flattenEvtNames = await parseLogs(rpcProviders[items[1]], items[2]);
      const newLine = `${readCount},${line},${flattenEvtNames}\n`;
      dataLogger.write(newLine);
      readCount++;
    }
  } catch (e: unknown) {
    console.log("Unknow error: ", e);
  }
  const metaDataLogger = createWriteStream("./metadata.json", { flags: "w" }); // write mode
  metaDataLogger.write(JSON.stringify({ readCount }));
  console.log(`total count: ${totalCount}, readCount: ${readCount}`);
  console.log(`app end`);
};

main();
