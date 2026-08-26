/** Raised by providers when the server rejects the `tools` parameter for this model. */
export class ToolsUnsupportedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ToolsUnsupportedError';
    }
}
export class ProviderHttpError extends Error {
    status;
    body;
    constructor(status, body, url) {
        super(`HTTP ${status} from ${url}: ${body.slice(0, 500)}`);
        this.status = status;
        this.body = body;
        this.name = 'ProviderHttpError';
    }
}
//# sourceMappingURL=types.js.map