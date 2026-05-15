import { Module } from '@nestjs/common';
import { getDb, type Database } from '@avito/db';

export const DB_TOKEN = Symbol.for('DB');

@Module({
  providers: [
    {
      provide: DB_TOKEN,
      useFactory: (): Database => getDb(),
    },
  ],
  exports: [DB_TOKEN],
})
export class DbModule {}
