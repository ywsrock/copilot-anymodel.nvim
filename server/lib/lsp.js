// Minimal JSON-RPC 2.0 over stdio with LSP Content-Length framing.

export const ErrorCodes = {
  MethodNotFound: -32601,
  InternalError: -32603,
  RequestCancelled: -32800,
};

export class ResponseError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function createConnection(input = process.stdin, output = process.stdout) {
  const requestHandlers = new Map();
  const notificationHandlers = new Map();
  const pending = new Map(); // id -> AbortController for in-flight requests
  let buffer = Buffer.alloc(0);

  function send(message) {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
    output.write(`Content-Length: ${body.length}\r\n\r\n`);
    output.write(body);
  }

  async function dispatch(message) {
    if (message.method === undefined) return; // responses to our requests are ignored
    if (message.id === undefined) {
      if (message.method === '$/cancelRequest') {
        pending.get(message.params?.id)?.abort();
        return;
      }
      const handler = notificationHandlers.get(message.method);
      if (handler) {
        try {
          await handler(message.params ?? {});
        } catch (err) {
          process.stderr.write(`notification ${message.method} failed: ${err.stack ?? err}\n`);
        }
      }
      return;
    }
    const handler = requestHandlers.get(message.method);
    if (!handler) {
      send({ id: message.id, error: { code: ErrorCodes.MethodNotFound, message: `Unhandled method ${message.method}` } });
      return;
    }
    const controller = new AbortController();
    pending.set(message.id, controller);
    try {
      const result = await handler(message.params ?? {}, controller.signal);
      if (controller.signal.aborted) {
        send({ id: message.id, error: { code: ErrorCodes.RequestCancelled, message: 'Request cancelled' } });
      } else {
        send({ id: message.id, result: result ?? null });
      }
    } catch (err) {
      const code = controller.signal.aborted ? ErrorCodes.RequestCancelled : (err.code ?? ErrorCodes.InternalError);
      send({ id: message.id, error: { code: typeof code === 'number' ? code : ErrorCodes.InternalError, message: String(err.message ?? err) } });
    } finally {
      pending.delete(message.id);
    }
  }

  function onData(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const match = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'));
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (buffer.length < start + length) return;
      const body = buffer.subarray(start, start + length).toString('utf8');
      buffer = buffer.subarray(start + length);
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        continue;
      }
      dispatch(message);
    }
  }

  return {
    onRequest(method, handler) {
      requestHandlers.set(method, handler);
    },
    onNotification(method, handler) {
      notificationHandlers.set(method, handler);
    },
    notify(method, params) {
      send({ method, params });
    },
    listen() {
      input.on('data', onData);
      input.on('end', () => process.exit(0));
    },
  };
}
