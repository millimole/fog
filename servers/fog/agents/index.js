// @ts-check

import { createConnection as createSciFinConnection } from './scifin_agent.js';
import { createConnection as createHTTPConnection } from './http_agent.js';
import net from 'node:net';
import { print } from '../../../logger.js';

/** @typedef {import('node:stream').Duplex} Duplex */
/**
 * @param {import('../../../types.js').Proxy[]} proxies
 * @param {import('../../../types.js').Target} target
 * @param {AbortSignal} signal
 * @returns {Promise<Duplex>}
 */
export async function createConnection(proxies, signal, target){
    print({level: -1}, ['conn', 'init'], 'Final target: %s:%s', target.hostname, target.port);
    /** @type {Promise<Duplex|undefined>} */
    const init = Promise.resolve(undefined);

    // create socket from config...
    const socket = await proxies.reduce(async (prev, curr, index) => {
        let socket = await prev;
        let next = proxies[index + 1] || target;
        if (curr.type == 'scifin')
            return await createSciFinConnection(curr, next, signal, socket);
        else if (curr.type == 'http')
            return await createHTTPConnection(curr, next, signal, socket);
    }, init);
    // ...but direct mode if no config
    if (socket === undefined) {
        return new Promise((resolve, reject) => {
            const socket = net.connect(
                { host: target.hostname, port: target.port},
                () => {
                    socket.off('error', reject);
                    print({ level: -1 }, ['direct', 'conn'], '%s:%s', target.hostname, target.port);
                    resolve(socket);
                }
            );
            socket.once('error', reject);
        });
    }
    else return socket;
        
}