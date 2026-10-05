// Side-effect import. Must be evaluated before `@actual-app/api`, which
// captures globalThis.fetch at load; see server-headers.ts.
import { installServerHeaderFetch } from './server-headers.js';

installServerHeaderFetch();
