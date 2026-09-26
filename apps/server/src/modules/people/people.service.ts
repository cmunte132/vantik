import { Injectable, NotFoundException } from '@nestjs/common';
import { CreatePersonDto } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import CompanyService from 'modules/company/company.service';

@Injectable()
export default class PeopleService {
  constructor(
    private prisma: PrismaService,
    private companyService: CompanyService,
  ) {}
  async createPerson(data: CreatePersonDto, workspaceId: string) {
    let companyId = data.companyId;

    // If company email domain is provided but no companyId, try to find or create company
    if (!companyId && data.email) {
      const domain = data.email.split('@')[1];
      if (domain) {
        // Try to find existing company by domain
        const existingCompany = await this.prisma.company.findFirst({
          where: {
            domain,
            workspaceId,
            deleted: null,
          },
        });

        if (existingCompany) {
          companyId = existingCompany.id;
        } else {
          // Create new company using domain
          const newCompany = await this.companyService.createCompany(
            {
              domain,
            },
            workspaceId,
          );
          companyId = newCompany.id;
        }
      }
    }
    return this.prisma.people.create({
      data: {
        ...data,
        companyId,
        workspaceId,
      },
      include: {
        company: true,
      },
    });
  }

  async getPerson(id: string) {
    const person = await this.prisma.people.findFirst({
      where: {
        id,
        deleted: null,
      },
      include: {
        company: true,
      },
    });

    if (!person) {
      throw new NotFoundException(`Person with ID ${id} not found`);
    }

    return person;
  }
}
