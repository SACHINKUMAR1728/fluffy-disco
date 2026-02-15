import { ShardCoordinator } from './src/index';

const shards = [
  {
    id: 'shard_1',
    host: '127.0.0.1',
    port: 15433,
    user: 'postgres',
    password: 'postgres',
    database: 'shard_1',
  },
  {
    id: 'shard_2',
    host: '127.0.0.1',
    port: 15434,
    user: 'postgres',
    password: 'postgres',
    database: 'shard_2',
  },
];

async function main() {
  const coordinator = new ShardCoordinator({ shards });
  console.log('Testing connection to shards...');
  try {
    const results = await coordinator.testConnection();
    console.log('Results:', JSON.stringify(results, null, 2));
    
    results.forEach(r => {
      if (!r.success) {
        console.error(`Detailed error for ${r.shardId}:`, r.error);
      }
    });
  } catch (error) {
    console.error('Fatal error during testConnection:', error);
  }
}

main().catch(console.error);
