import fs from 'fs';
import path from 'path';

const logsDir = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'logs')
  : './logs';
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const logFile = path.join(logsDir, `pipeline-${new Date().toISOString().slice(0, 10)}.log`);

function timestamp() {
  return new Date().toISOString();
}

function write(level, ...args) {
  const msg = `[${timestamp()}] [${level}] ${args.join(' ')}`;
  console.log(msg);
  fs.appendFileSync(logFile, msg + '\n');
}

export const logger = {
  info: (...args) => write('INFO', ...args),
  warn: (...args) => write('WARN', ...args),
  error: (...args) => write('ERROR', ...args),
  success: (...args) => write('OK', ...args),
};
