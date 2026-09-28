// A local dashboard for the Bull queues of the server. It is for development
// only. It has no login, and its actions can retry and delete jobs. For that
// reason, docker-compose.observability.yaml binds its port to 127.0.0.1.
//
// The server declares its queues in many modules. This script does not keep a
// list of them. It finds each queue from the keys in Redis. A queue with no
// keys does not show until it gets a job. The script looks again every 30
// seconds.
const express = require('express');
const Queue = require('bull');
const Redis = require('ioredis');
const { createBullBoard } = require('@bull-board/api');
const { BullAdapter } = require('@bull-board/api/bullAdapter');
const { ExpressAdapter } = require('@bull-board/express');

const redis = {
  host: process.env.REDIS_HOST || 'redis',
  port: Number(process.env.REDIS_PORT || 6379),
};
const prefix = process.env.BULL_PREFIX || 'bull';
const port = Number(process.env.PORT || 3000);

const client = new Redis(redis);
const queues = new Map();

const serverAdapter = new ExpressAdapter();
const board = createBullBoard({ queues: [], serverAdapter });

// Bull stores each queue under the keys `<prefix>:<queue>:<suffix>`. This
// function reads the queue names from those keys and adds each new queue to
// the board.
async function discoverQueues() {
  const names = new Set();
  let cursor = '0';
  do {
    const [next, keys] = await client.scan(
      cursor,
      'MATCH',
      `${prefix}:*`,
      'COUNT',
      1000,
    );
    cursor = next;
    for (const key of keys) {
      names.add(key.split(':')[1]);
    }
  } while (cursor !== '0');

  const added = [...names].filter((name) => !queues.has(name));
  if (added.length === 0) {
    return;
  }
  for (const name of added) {
    queues.set(name, new Queue(name, { redis, prefix }));
  }
  const sorted = [...queues.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  board.replaceQueues(sorted.map((queue) => new BullAdapter(queue)));
  console.log(`queues: ${[...queues.keys()].sort().join(', ')}`);
}

discoverQueues().catch(console.error);
setInterval(() => discoverQueues().catch(console.error), 30_000);

const app = express();
app.use('/', serverAdapter.getRouter());
app.listen(port, () => console.log(`bull-board on :${port}`));
