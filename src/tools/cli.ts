import { runTools, writers } from "./dispatch.js"

process.exitCode = await runTools(process.argv.slice(2), process.env, writers)
