'use strict';
const os = require('os');

function createSystemModule() {
    return {
        getInterfaces: () => {
            const results = [];
            for (const name of Object.keys(os.networkInterfaces())) {
                for (const iface of os.networkInterfaces()[name]) {
                    if (iface.family === 'IPv4' && !iface.internal) {
                        results.push({ name, ip: iface.address, netmask: iface.netmask, mac: iface.mac });
                    }
                }
            }
            return results;
        }
    };
}

module.exports = { createSystemModule };
