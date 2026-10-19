import {dirname,isAbsolute} from 'node:path';
import {convertV4MiniflareOptions} from 'miniflare';

/** Bundled integration workers live outside cwd. Keep their virtual module names inside that bundle directory. */
export function workerFixtureOptions(options){
 if(options.modules!==true||typeof options.scriptPath!=='string'||!isAbsolute(options.scriptPath))throw Error('Worker fixtures require an absolute bundled module path.');
 return convertV4MiniflareOptions({...options,modulesRoot:dirname(options.scriptPath)});
}
