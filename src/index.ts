import { startServer } from './lifecycle.js';
import { logError } from './util/logger.js';

startServer().catch((err) => {
  logError('Fatal error starting CrossChat server', err);
  process.exit(1);
});
