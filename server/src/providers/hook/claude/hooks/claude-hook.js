"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const http = __importStar(require("http"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const constants_js_1 = require("../../../../constants.js");
const SERVER_JSON = path.join(os.homedir(), constants_js_1.SERVER_JSON_DIR, constants_js_1.SERVER_JSON_NAME);
async function main() {
    let input = '';
    for await (const chunk of process.stdin)
        input += chunk;
    let data;
    try {
        data = JSON.parse(input);
    }
    catch {
        process.exit(0);
    }
    let server;
    try {
        server = JSON.parse(fs.readFileSync(SERVER_JSON, 'utf-8'));
    }
    catch {
        process.exit(0);
    }
    const body = JSON.stringify(data);
    return new Promise((resolve) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port: server.port,
            path: `${constants_js_1.HOOK_API_PREFIX}/claude`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                Authorization: `Bearer ${server.token}`,
            },
            timeout: 2000,
        }, () => resolve());
        req.on('error', () => resolve());
        req.on('timeout', () => {
            req.destroy();
            resolve();
        });
        req.end(body);
    });
}
main()
    .catch(() => { })
    .finally(() => process.exit(0));
//# sourceMappingURL=claude-hook.js.map