'use strict';

const mongoose = require('mongoose');
const { parseArgs, provision } = require('./dbm-executive/provision');

(async () => {
  const args = parseArgs(process.argv.slice(2));
  try {
    const result = await provision({ dryRun: args.dryRun });
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.dryRun) {
      console.log('DBM Executive Advisor dry run is valid.');
      console.log(JSON.stringify(result.blueprint, null, 2));
    } else {
      console.log(`DBM Executive Advisor provisioned for ${result.owner}.`);
      for (const change of result.changes) {
        console.log(`- ${change.action}: ${change.name} (${change.id})`);
      }
      console.log(`Executive agent ID: ${result.executiveId}`);
    }
  } catch (error) {
    console.error(`DBM Executive Advisor provisioning failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  }
})();
