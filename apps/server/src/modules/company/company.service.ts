import { Injectable } from '@nestjs/common';
import { UpsertCompanyDto } from '@vantikhq/types';
import axios from 'axios';
import { PrismaService } from 'nestjs-prisma';

@Injectable()
export default class CompanyService {
  constructor(private prisma: PrismaService) {}
  async createCompany(data: UpsertCompanyDto, workspaceId: string) {
    // If only domain is provided, try to enrich the data
    if (data.domain && !data.name) {
      const enrichedData = await this.enrichCompanyData(data.domain);
      if (enrichedData) {
        data = { ...data, ...enrichedData };
      } else {
        data = {
          ...data,
          name: data.domain.split('.')[0].toUpperCase(),
        };
      }
    }

    return this.prisma.company.create({
      data: {
        ...data,
        name: data.name,
        workspace: {
          connect: {
            id: workspaceId,
          },
        },
      },
      include: {
        people: true,
      },
    });
  }

  async enrichCompanyData(domain: string) {
    try {
      const apolloApiKey = process.env.APOLLO_API_KEY;
      const response = await axios.post(
        'https://api.apollo.io/v1/organizations/enrich',
        {
          domain,
        },
        {
          headers: {
            'X-API-Key': apolloApiKey,
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
          },
        },
      );

      const organization = response.data.organization;
      if (!organization) {
        return null;
      }

      // Transform Apollo data to our format
      return {
        name: organization.name,
        website: organization.website_url,
        domain,
        description: organization.short_description,
        industry: organization.industry,
        metadata: {
          size: organization.estimated_num_employees,
          logo: organization.logo_url,
          location: {
            city: organization.city,
            state: organization.state,
            country: organization.country,
          },
          linkedin: organization.linkedin_url,
          founded: organization.founded_year,
        },
      };
    } catch (error) {
      console.error('Apollo company enrichment failed:', error);
      return null;
    }
  }
}
