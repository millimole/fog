// @ts-check
import { ServerResponse, createServer } from 'node:http';
import http from 'node:http';
import { inspect } from 'node:util';
import { print } from '../../logger.js';
import { logOnErr, removeHopByHop } from '../../util.js';
import { awaitConfig } from '../../config.js';
import { createConnection } from './agents/index.js';

const {proxies, ...config} = await awaitConfig();

const server = createServer(async (req, res) => {
    const unbindReqErrLog = logOnErr(req, 'client');
    try{
        const ac = new AbortController();
        const url = new URL(req.url/*?.replace(/^(\/+)/, '')*/ || ''); // delete starting slashes - autocannon tests
        const headers = removeHopByHop(req.headers);
        if(url.protocol !== 'http:') return res.writeHead(400).end('https: requests should be made through CONNECT proxies');
        
        function abort(){ ac.abort(); }
        req.socket.on('close', abort);
        const target = await createConnection(proxies, ac.signal, {hostname: url.hostname, port: +(url.port || '80')});
        const foreign = http.request(url, {
            method: req.method, headers, signal: ac.signal,
            createConnection: ()=>(/** @type {import('node:net').Socket}*/ (target)),
        }, onResp);

        req.socket.off('close', abort);
        req.pipe(foreign);
        req.socket.once('close', cleanup1);
        foreign.once('close', cleanup1);
        req.once('error', onError);
        foreign.once('error', onError);

        function onError(err){
            if(this === target) print({level: 2}, ['foreign', 'err'], '%s %s', url, err.code||err.message);
            else if(this === foreign) print({level: 2}, ['client', 'err'], '%s %s', url, err.code||err.message);
            else print({level: 2}, '%s %s', url, err.code||err.message);
        }

        function cleanup1(){
            foreign.off('response', onResp);
            foreign.off('close', cleanup1);
            req.socket.off('close', cleanup1);
        }
        function onResp(resp){
            const headers = removeHopByHop(resp.headers);
            res.writeHead(resp.statusCode||200, resp.statusMessage, headers);
            resp.pipe(res);
        }
    } catch(e){
        // handle any errors during connection
        const debug = inspect(e);
        print({ level: 2 }, ['connect', 'err'], e.message || debug);
        if(res.headersSent){
            print({level: 1}, ['cleanup'], 'Headers were sent already when error occurred');
            res.destroy();
            req.destroy();
        }
        else if (e?.code == 'ENOTFOUND') res.writeHead(404).end(`Host or proxy ${e?.hostname} not found, try checking your URL or proxy config file.`, unbindReqErrLog);
        else if (e?.code == 'ERR_INVALID_URL') res.writeHead(400).end('Invalid URL', unbindReqErrLog);
        else res.writeHead(500).end(e.message || debug, unbindReqErrLog);
    }
})
    .on('connect', async function onconnect(req, /** @type {import('node:net').Socket} */client) {
        // Code is mostly based on the `proxy` library.
        
        req.pause();
        const res = new ServerResponse(req);
        const ac = new AbortController();
        const unbindErrHandler = logOnErr(req, 'client');
        const url = req.headers.host || req.url;
        res.shouldKeepAlive = false;
        res.chunkedEncoding = false;
        res.useChunkedEncodingByDefault = false;
        res.assignSocket(client);
        function onFinish() {
            if (res) { res.detachSocket(client); res.destroy(); }
            client.end();
        }
        res.once('finish', onFinish);
        
        if (!url) {
            print({level:1}, ['client', 'err'], 'No `Host` header or target URL given');
            return res.writeHead(400).end('No `Host` header or target URL given.');
        }
        if (!authenticate(req)) return res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="proxy"' }).end();
        try {
            const { hostname, port: _port } = new URL('http://' + url);
            const port = _port || '80';
            function abort(){ac.abort();}
            client.on('close', abort);
            const target = await createConnection(proxies, ac.signal, {hostname, port: +port});

            // Send 200
            client.off('close', abort);
            res.off('finish', onFinish)
                .writeHead(200, 'Connection established')
                .flushHeaders();
            res.detachSocket(client);
            res.destroy();
            client.pipe(target);
            target.pipe(client);
            req.resume();

            // error management, cleanup

            unbindErrHandler();
            target.once('close', cleanup);
            client.once('close', cleanup);
            target.once('error', onError);
            client.once('error', onError);
            function cleanup() {
                target.unpipe(client);
                if(this !== client) client.destroy();
                if(this !== target) target.destroy();
            }
            function onError(err){
                if(this == target) print({level: 2}, ['foreign', 'err'], '%s:%s %s', hostname, port, err.code||err.message);
                else if(this == client) print({level: 2}, ['client', 'err'], '%s:%s %s', hostname, port, err.code||err.message);
                else print({level: 2}, ['err'], '%s:%s %s', hostname, port, err.code||err.message);
            }
        } catch (e) {
            // handle any errors during connection
            const debug = inspect(e);
            print({ level: 2 }, ['connect', 'err'], debug);
            if(res.destroyed) print({level: 1}, ['cleanup'], 'res already destroyed');
            else if (e?.code == 'ENOTFOUND') res?.writeHead(404).end(`Host or proxy ${e?.hostname} not found, try checking your URL or proxy config file.`);
            else if (e?.code == 'ERR_INVALID_URL') res?.writeHead(400).end('Invalid URL');
            else res.writeHead(500).end(debug);
        }
    })
    .listen(config.port);
process.on('exit', () =>{
    print({level: 1}, ['exit'], 'Worker exiting...');
    server.close();
});
function authenticate(/** @type {import('node:http').IncomingMessage} */ req) {
    return (req.headers['proxy-authorization'] ?? '') == (config.auth??'');
}