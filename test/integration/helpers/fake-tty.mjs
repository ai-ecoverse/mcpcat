import { syncBuiltinESMExports } from 'node:module';
import tty from 'node:tty';

tty.isatty = () => true;
syncBuiltinESMExports();
