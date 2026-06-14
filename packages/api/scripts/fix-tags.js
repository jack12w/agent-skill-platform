"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const skill_entity_1 = require("../src/skills/skill.entity");
const dotenv_1 = require("dotenv");
(0, dotenv_1.config)({ path: '.env.production' });
async function main() {
    const ds = new typeorm_1.DataSource({
        type: 'postgres',
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432'),
        username: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASS,
        database: process.env.DB_NAME || 'agent_skills',
        entities: [skill_entity_1.Skill],
    });
    await ds.initialize();
    const repo = ds.getRepository(skill_entity_1.Skill);
    const skills = await repo.find();
    for (const skill of skills) {
        if (!skill.tags?.length)
            continue;
        const newTags = [];
        for (const tag of skill.tags) {
            if (tag.includes('，')) {
                tag.split(/[，,]/).map(t => t.trim()).filter(Boolean).forEach(t => newTags.push(t));
                continue;
            }
            if (tag === '国际站') {
                newTags.push('阿里国际站');
            }
            else if (tag === '生意助手') {
                newTags.push('国际站生意助手');
            }
            else {
                newTags.push(tag);
            }
        }
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
//# sourceMappingURL=fix-tags.js.map