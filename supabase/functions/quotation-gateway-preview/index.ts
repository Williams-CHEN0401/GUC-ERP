// The Preview endpoint deliberately reuses the production handler. The handler
// derives read-only Preview mode from the exact deployed function path and
// rejects every mutation except login before any production RPC is called.
import "../quotation-gateway/index.ts";
