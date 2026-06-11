import { SqlStore } from "../workers/sqlStore.ts";
import { createSqlStorage } from "./sqlStorageShim.ts";
import { runStoreContract } from "./storeContract.ts";

runStoreContract("SqlStore", () => new SqlStore(createSqlStorage()));
