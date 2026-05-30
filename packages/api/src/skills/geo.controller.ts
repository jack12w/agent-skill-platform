import { Controller, Get, Query } from '@nestjs/common';
import { SkillsService } from '../skills/skills.service';

@Controller('ai')
export class GeoController {
  constructor(private skillsService: SkillsService) {}

  @Get('feed')
  async getFeed(@Query('page') page: number = 1, @Query('page_size') size: number = 100) {
    // This calls the service to get a machine-readable summary for GEO
    return this.skillsService.getGeoFeed(page, size);
  }
}
