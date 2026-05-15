import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LoggerService } from '@nestjs/common';
import { STORAGE_DIRS } from '@avito/shared';

function dateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

export class FileLogger implements LoggerService {
  private readonly stream: fs.WriteStream;

  constructor(private readonly serviceName: string) {
    fs.mkdirSync(STORAGE_DIRS.logs, { recursive: true });
    const file = path.join(STORAGE_DIRS.logs, `${serviceName}-${dateStamp()}.log`);
    this.stream = fs.createWriteStream(file, { flags: 'a' });
  }

  private write(level: string, message: unknown, context?: string): void {
    const ts = new Date().toISOString();
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    const line = `${ts} [${level}] [${context ?? this.serviceName}] ${text}\n`;
    this.stream.write(line);
    process.stdout.write(line);
  }

  log(message: unknown, context?: string): void {
    this.write('INFO', message, context);
  }

  error(message: unknown, trace?: string, context?: string): void {
    this.write('ERROR', message, context);
    if (trace) this.write('ERROR', trace, context);
  }

  warn(message: unknown, context?: string): void {
    this.write('WARN', message, context);
  }

  debug(message: unknown, context?: string): void {
    this.write('DEBUG', message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.write('VERBOSE', message, context);
  }
}
