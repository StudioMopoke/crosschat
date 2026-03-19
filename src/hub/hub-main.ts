import { startHub } from './hub-server.js';
import { log, logError } from '../util/logger.js';

process.on('uncaughtException', (err) => {
  logError('Uncaught exception in hub', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logError('Unhandled rejection in hub', reason);
  process.exit(1);
});

log('Starting CrossChat hub...');

startHub().catch((err) => {
  logError('Fatal error starting hub', err);
  process.exit(1);
});
