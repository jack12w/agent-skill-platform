/**
 * 修复数据库中标签中文逗号问题 + 旧标签重命名
 * 在服务器上运行: docker exec skills-api node dist/scripts/fix-tags.js
 */
import { DataSource } from 'typeorm';
import { Skill } from '../src/skills/skill.entity';
import { config } from 'dotenv';

config({ path: '.env.production' });

async function main() {
  const ds = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    username: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASS,
    database: process.env.DB_NAME || 'agent_skills',
    entities: [Skill],
  });

  await ds.initialize();
  const repo = ds.getRepository(Skill);
  const skills = await repo.find();

  for (const skill of skills) {
    if (!skill.tags?.length) continue;

    const newTags: string[] = [];

    for (const tag of skill.tags) {
      // 1. 中文逗号拆分（如 "automation，accio work，阿里国际站"）
      if (tag.includes('，')) {
        tag.split(/[，,]/).map(t => t.trim()).filter(Boolean).forEach(t => newTags.push(t));
        continue;
      }

      // 2. 旧标签重命名
      if (tag === '国际站') {
        newTags.push('阿里国际站');
      } else if (tag === '生意助手') {
        newTags.push('国际站生意助手');
      } else {
        newTags.push(tag);
      }
    }

    // 去重
    const unique = [...new Set(newTags)];
    if (JSON.stringify(unique) !== JSON.stringify(skill.tags)) {
      skill.tags = unique;
      await repo.save(skill);
      console.log(`[OK] ${skill.name}: ${skill.tags.join(', ')} → ${unique.join(', ')}`);
    }
  }

  console.log('Done.');
  await ds.destroy();
}

main().catch(console.error);
