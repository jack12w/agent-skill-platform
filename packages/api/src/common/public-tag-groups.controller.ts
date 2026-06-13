import { Controller, Get } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TagGroup } from './tag-group.entity';

/** Public endpoint — no auth required, used by frontend pages to render tag filters */
@Controller('tags/groups')
export class PublicTagGroupsController {
  constructor(
    @InjectRepository(TagGroup) private tagGroupRepo: Repository<TagGroup>,
  ) {}

  @Get()
  list() {
    return this.tagGroupRepo.find({ order: { created_at: 'ASC' } });
  }
}
