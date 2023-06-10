// @ts-check
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { format, print } from '../../../logger.js';
import { version } from '../../../util.js';
/** @typedef {import('node:stream').Duplex} Duplex */
/**
 * @param {import('../../../types.js').Proxy} proxy
 * @param {import('../../../types.js').Target} next
 * @param {AbortSignal} signal
 * @param {Duplex} [socket]
 * @returns {Promise<Duplex>}
 * */
export async function createConnection(proxy, next, signal, socket){
    /** @type {Duplex}*/
    let _socket = await new Promise((resolve, reject)=>{
        if(socket && !proxy.tls && !proxy.ssl) return resolve(socket);
        const _socket = proxy.tls||proxy.ssl?
            tls.connect({host: proxy.hostname, port: proxy.port, socket: socket}, onceSuccess):
            net.connect({host: proxy.hostname, port: proxy.port, signal}, onceSuccess);
        function onceSuccess(){ resolve(_socket); _socket.off('error', reject); socket?.off('error', reject); }
        function onceClose(){
            print({level: -1}, ['conn', 'cleanup'], '%s:%s', proxy.hostname, proxy.port);
            _socket.destroy();
            if(socket) socket.destroy();
        }
        socket?.once('error', reject);
        _socket.once('error', reject);
        _socket.once('close', onceClose);
    });
    let request = http.request({
        hostname: proxy.hostname,
        port: proxy.port,
        method:'CONNECT', signal,
        path: next.hostname+':'+next.port,
        // @ts-ignore createConnection() can return any value as long as it is a Duplex.
        createConnection: ()=>_socket,
        headers:{ host: next.hostname+':'+next.port, }
    });
    request.setHeader('User-Agent', 'fog/v' + version);
    if(proxy.authorization) request.setHeader('Proxy-Authorization', proxy.authorization);
    return await (new Promise((resolve, reject)=>{
        function onErrorBeforeConnect(error){
            request.off('connect', onconnect);
            request.destroy();
            _socket.destroy();
            reject(error);
        }
        _socket.once('error', onErrorBeforeConnect);
        request.once('error', onErrorBeforeConnect);
        request.once('connect', onconnect);
        request.end();
        async function onconnect(/** @type {http.IncomingMessage} */ _res, /** @type {net.Socket} */res_socket){
            request.off('error', onErrorBeforeConnect);
            _socket.off('error', onErrorBeforeConnect);
            if(_res.statusCode !== 200){
                request.destroy();
                _socket.destroy();
                print( {level: -1}, '%s:%s returned error %d with headers %o',
                    proxy.hostname, proxy.port,
                    _res.statusCode, _res.headers
                );
                return reject(format({level: 2}, ['handshake', 'err'], 'Status code during handshake: %d', _res.statusCode));
            }
            print({level:-1}, ['http', 'conn'], '%s:%s via proxy %s:%s', next.hostname, next.port, proxy.hostname, proxy.port);
            function onError(/** @type {NodeJS.ErrnoException} */ err){
                res_socket.off('error', onError);
                request.off('error', onError);
                res_socket.destroy();
                request.end(()=>request.destroy());
                _socket.destroy();
                print({level:2}, ['http', 'err'], err.code || err.message);
            }
            request.once('error', onError);
            res_socket.once('error', onError);
            resolve(res_socket);
        }
    }));
}