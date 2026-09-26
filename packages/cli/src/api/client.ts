import axios from 'axios';

export class ApiClient {
  private apiUrl: string;

  constructor(apiUrl: string) {
    this.apiUrl = apiUrl;
  }

  async createAuthorizationCode() {
    const response = await axios.get(
      `${this.apiUrl}/api/v1/users/authorization`,
    );

    const code = response.data.code;

    return {
      url: `${this.apiUrl}/authorize?code=${code}`,
      code,
    };
  }

  async getPersonalAccessToken(code: string) {
    const response = await axios.post(
      `${this.apiUrl}/api/v1/users/pat-for-code`,
      {
        code,
      },
    );

    const token = response.data.token;
    const workspaceId = response.data.workspaceId;

    return {
      token,
      workspaceId,
    };
  }
}
