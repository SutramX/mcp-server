import net from 'node:net';

/**
 * A port nothing is listening on right now, from the OS (bind to 0, read it,
 * close). The spawned MCP server cannot report a port it picked itself, and a
 * random port in a fixed range could already be taken on a busy machine
 * (EADDRINUSE, server exits 1).
 */
export function freePort(host = '127.0.0.1'): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.once('error', reject);
        server.listen(0, host, () => {
            const { port } = server.address() as net.AddressInfo;
            server.close(() => resolve(port));
        });
    });
}
