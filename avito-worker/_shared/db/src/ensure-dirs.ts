import * as fs from 'node:fs/promises';
import { STORAGE_DIRS } from '@avito/shared';

export async function ensureStorageDirs(): Promise<void> {
  await Promise.all(
    Object.values(STORAGE_DIRS).map((dir) =>
      fs.mkdir(dir, { recursive: true }),
    ),
  );
}
