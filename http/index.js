'use strict';

const ThreadPool = require('threadpool').default;
const argv = require('minimist')(process.argv.slice(2));
const fs = require('fs');
const http = require('http');
const { promisify } = require('util');
const path = require('path');

process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0;

const thread_no = (argv.hasOwnProperty('threads') && typeof(argv['threads']) == 'number') ? argv['threads'] : 1;
const ops_no = (argv.hasOwnProperty('ops') && typeof(argv['ops']) == 'number') ? argv['ops'] : 1;
const https_port = 8000;
if(!argv.hasOwnProperty('host') || typeof(argv['host']) != 'string') {
    return new Error('No Host specified! Use -host XXX')
}

const https_host = argv['host'];
if(!argv.hasOwnProperty('function') || typeof(argv['function']) != 'string') {
    return new Error('No function specified! Use -function XXX');
}
const https_function = argv['function'];
const http_agent_reuse = (argv.hasOwnProperty('agentreuse') && typeof(argv['agentreuse']) == 'boolean') ? argv['agentreuse'] : false;
const http_timeout = (argv.hasOwnProperty('timeout') && typeof(argv['timeout']) == 'number') ? argv['timeout'] : false;

let averageLatency;
let throughput;
let totalExecutionTime;
let percentile95;
let percentile99;
let medianLatency;

async function main() {

    const appendFileAsync = promisify(fs.appendFile);

    function sendHttpRequest(http_host, http_port, http_function, http_timeout) {
        return new Promise((resolve, reject) => {
            let req = http.request({
                host: http_host,
                port: http_port,
                path: http_function,
                agent: http_agent_reuse

            }, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    resolve({ data: data, status: res.statusCode });
                });
            });

            req.on('error', (e) => {
                reject(e);
            });

            if (http_timeout) {
                req.setTimeout(http_timeout, () => {
                    req.abort();
                    reject(new Error('Request timed out'));
                });
            }

            req.end();
        });
    }

    async function generateWorkload(threadId, http_host, http_port, http_function, http_timeout) {
        let successCount = 0;
        let latencies = [];

        for (let operationId = 0; operationId < ops_no; operationId++) {
            const startTime = Date.now();
            try {
                const response = await sendHttpRequest(http_host, http_port, http_function, http_timeout);
                const endTime = Date.now();
                const latency = endTime - startTime;
                latencies.push(latency);

                await appendFileAsync('log.txt', `Thread ${threadId}, Operation ${operationId}, Status: ${response.status}, Latency: ${latency}ms\n`);

                if (response.status === 200) {
                    successCount++;
                }
            } catch (error) {
                console.error('HTTP request error:', error);
            }
        }

        return { successCount, latencies };
    }

    function calculatePercentile(data, percentile) {
        const index = Math.ceil(percentile / 100 * data.length) - 1;
        return data[index];
    }

    const startTime = Date.now();
    let simulatedThreads = [];
    for (let i = 0; i < thread_no; i++) {
        simulatedThreads.push(generateWorkload(i, https_host, https_port, https_function, http_timeout));
    }

    const results = await Promise.all(simulatedThreads);
    const totalLatencies = results.flatMap(result => result.latencies);

    totalLatencies.sort((a, b) => a - b);

    const middleIndex = Math.floor(totalLatencies.length / 2);
    if (totalLatencies.length % 2 === 0) {
        medianLatency = (totalLatencies[middleIndex - 1] + totalLatencies[middleIndex]) / 2;
    } else {
        medianLatency = totalLatencies[middleIndex];
    }

    percentile95 = calculatePercentile(totalLatencies, 95);
    percentile99 = calculatePercentile(totalLatencies, 99);
    const totalLatency = totalLatencies.reduce((acc, latency) => acc + latency, 0);
    averageLatency = totalLatency / totalLatencies.length;
    const endTime = Date.now();
    totalExecutionTime = endTime - startTime;
    const totalOperations = thread_no * ops_no;
    throughput = totalOperations / (totalExecutionTime / 1000);
}

(async () => {
    try {
        await main();

        const params = {
            protocol: 'http:',
            func: https_function,
            threads: thread_no,
            ops: ops_no,
        }

        const data = fs.readFileSync('../machine_type/infra.txt', 'utf8');
        const machineType = data.split('=')[1].trim().replace(/"/g, '');

        const prepareRes = function () {
            return {
                throughput: {
                    name: "throughput",
                    value: throughput.toFixed(2),
                    unit: "ops/s"
                },
                ave_latency: {
                    name: "avg latency",
                    value: averageLatency.toFixed(2),
                    unit: "ms"
                },
                percentile95: {
                    name: "95th percentile latency",
                    value: percentile95.toFixed(2),
                    unit: "ms"
                },
                percentile99: {
                    name: "99th percentile latency",
                    value: percentile99.toFixed(2),
                    unit: "ms"
                },
                median_latency: {
                    name: "median latency",
                    value: medianLatency.toFixed(2),
                    unit: "ms"
                }
            }
        }

        const res = prepareRes();

        const formatTime = function formatTime(milliseconds) {
            const minutes = Math.floor(milliseconds / 60000);
            const seconds = ((milliseconds % 60000) / 1000).toFixed(0);
            return minutes + "m " + (seconds < 10 ? '0' : '') + seconds + "s";
        }

        const json = {
            date: new Date(),
            benchInfo: {
                executionTime: formatTime(totalExecutionTime),
                parametrization: params,
                otherInfo: `edge-server: ${machineType}`
            },
            results: [res.ave_latency, res.throughput, res.percentile95, res.percentile99, res.median_latency]
        }

        fs.writeFileSync('results.json', JSON.stringify(json));

    } catch (e) {
        console.log(e);
    }
})();
