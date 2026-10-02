import { SuiteSchema, type Suite } from "../engine/suite";
import { parseInput, readJsonFile } from "./args";

export function loadSuite(path: string): Suite {
  return parseInput(SuiteSchema, readJsonFile(path, `${path} is not a JSON suite`), path);
}
