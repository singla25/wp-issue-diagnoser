// Proves block-network.js also covers worker threads: a worker tries to fetch; the attempt must be refused and logged.
const { Worker } = require('worker_threads');
const w = new Worker("fetch('https://example.com/').then(() => process.exit(0), () => process.exit(7));", { eval: true });
w.on('exit', code => process.exit(code));
