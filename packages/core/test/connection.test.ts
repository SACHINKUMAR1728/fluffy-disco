import { ShardCoordinator, ShardConfig } from '../src/index';

describe('Shard connection test', () => {
  const shards: ShardConfig[] = [
    {
      id: 'shard_1',
      host: 'localhost',
      port: 15433,
      user: 'postgres',
      password: 'postgres',
      database: 'shard_1',
    },
    {
      id: 'shard_2',
      host: 'localhost',
      port: 15434,
      user: 'postgres',
      password: 'postgres',
      database: 'shard_2',
    },
  ];

  const coordinator = new ShardCoordinator({ shards });

  it('should connect to both shards successfully', async () => {
    const results = await coordinator.testConnection();
    
    expect(results).toHaveLength(2);
    
    results.forEach((result) => {
      if (!result.success) {
        console.error(`Failed to connect to ${result.shardId}: ${result.error}`);
      }
      expect(result.success).toBe(true);
    });
  }, 15000); // Increased timeout for docker instances
});
