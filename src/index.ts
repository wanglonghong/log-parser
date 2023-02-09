import { Contract, Interface, JsonRpcProvider } from "ethers";
import { createReadStream, createWriteStream, existsSync, readFileSync } from "fs";
import  { createInterface } from "readline";
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
    const parsedLogs = receipt.logs.map((log: any) => {
        return {connext: connextInterface.parseLog(log), spokeConnector: spokeConectorInterface.parseLog(log), hubConnector: hubConnectorInterface.parseLog(log), rootManager: rootManagerInterface.parseLog(log)}
    }).filter(i => i.connext || i.spokeConnector || i.hubConnector || i.rootManager);

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
    console.log({parsedLogs, flattenParsedLogs});
    return flattenParsedLogs.length > 0 ? flattenParsedLogs : "NoEvents";
}

const main = async () => {

    console.log(`[x] Reading rpc providers from config.json...`);
    let rpcProviders: any = {};
    try {

        let json: string ;
        const path = "config.json";
        if (existsSync(path)) {
            json = readFileSync(path, {encoding: "utf-8"});
            rpcProviders = JSON.parse(json);
        }
    } catch (e: unknown) {
        console.error("Error reading file");
        process.exit(1);
    }
    console.log("Rpc providers: ");
    console.log(rpcProviders);
    const chainIds = Object.keys(rpcProviders);

    console.log(`[x] Reading raw data from data.csv...`);
    const readInterface = createInterface({input: createReadStream("./data.csv")});
    const logger = createWriteStream("./data_converted.csv", { flags: "a"}); // append mode
    let count = 0;
    let skipped = 0;
    for await (const line of readInterface) {
        count++;
        console.log(`[${count}]:  ${line}`);
        
        // parse the following lines
        // 2023-02-06 05:40:56.016399,42161,0x32c2631d5bc88e78105edf7543158689720d2f4de969b79b946f16c83e629e21,0x64e54a6a771267b35a40dc14cf80921a6afb05990d086186b2d2f9c591087d92,296903,$0.30
        const items = line.split(",");
        console.log(`item: ${items[1]}, type: ${typeof items[1]}`);
        if (typeof items[1] == "string" && chainIds.includes(items[1])) {
            const flattenEvtNames = await parseLogs(rpcProviders[items[1]], items[2]);
            const newLine = `${line},${flattenEvtNames}\n`;
            logger.write(newLine);
        } else {
            skipped++;
            continue;
        }
    }
    console.log(`total count: ${count}, skipped: ${skipped}`);
    console.log(`app end`);
}

main();