import {dirname,isAbsolute} from 'node:path';
import {convertV4MiniflareOptions} from 'miniflare';

/** Test-only bundled workers live outside cwd. Keep virtual module names inside their bundle directory. */
export function workerFixtureOptions(options){
 if(options.modules!==true||typeof options.scriptPath!=='string'||!isAbsolute(options.scriptPath))throw Error('Worker fixtures require an absolute bundled module path.');
 return convertV4MiniflareOptions({...options,modulesRoot:dirname(options.scriptPath)});
}
