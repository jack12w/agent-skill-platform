import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Skill } from '../skills/skill.entity';
import { User } from '../auth/user.entity';
import { Team } from '../teams/team.entity';
import { Comment } from '../skills/comment.entity';

@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(Skill) private skillRepo: Repository<Skill>,
    @InjectRepository(User) private userRepo: Repository<User>,
    @InjectRepository(Team) private teamRepo: Repository<Team>,
    @InjectRepository(Comment) private commentRepo: Repository<Comment>,
  ) {}

  async getStats() {
    const [skillsTotal, usersTotal, teamsTotal, commentsTotal, publishedSkills] =
      await Promise.all([
        this.skillRepo.count(),
        this.userRepo.count(),
        this.teamRepo.count(),
        this.commentRepo.count(),
        this.skillRepo.count({ where: { status: 'published' } }),
      ]);

    return {
      skills: { total: skillsTotal, published: publishedSkills },
      users: { total: usersTotal },
      teams: { total: teamsTotal },
      comments: { total: commentsTotal },
    };
  }
}
