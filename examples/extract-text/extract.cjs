const {createInterface} = require('node:readline');

const input = createInterface({input: process.stdin});
input.once('line', line => {
  const call = JSON.parse(line);
  input.close();
  const reply = {id: call.id, result: call.data.text.trim()};
  process.stdout.write(JSON.stringify(reply) + '\n', error => process.exit(error ? 1 : 0));
});
