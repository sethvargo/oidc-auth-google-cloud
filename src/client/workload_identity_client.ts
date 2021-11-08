'use strict';

import { URL } from 'url';
import { AuthClient } from './auth_client';
import { writeSecureFile } from '../utils';
import { BaseClient } from '../base';

/**
 * Available options to create the WorkloadIdentity client.
 *
 * @param projectID User-supplied value for project ID. If not provided, the
 * project ID is extracted from the service account email.
 * @param providerID Full path (including project, location, etc) to the Google
 * Cloud Workload Identity Provider.
 * @param serviceAccount Email address or unique identifier of the service
 * account to impersonate
 * @param token GitHub OIDC token to use for exchanging with Workload Identity
 * Federation.
 * @param audience The value for the audience parameter in the generated GitHub
 * Actions OIDC token, defaults to the value of workload_identity_provider
 */
interface WorkloadIdentityClientOptions {
  projectID?: string;
  providerID: string;
  serviceAccount: string;
  token: string;
  audience: string;
}

export class WorkloadIdentityClient implements AuthClient {
  readonly #projectID: string;
  readonly #providerID: string;
  readonly #serviceAccount: string;
  readonly #token: string;
  readonly #audience: string;

  constructor(opts: WorkloadIdentityClientOptions) {
    this.#providerID = opts.providerID;
    this.#serviceAccount = opts.serviceAccount;
    this.#token = opts.token;
    this.#audience = opts.audience;

    this.#projectID =
      opts.projectID || this.extractProjectIDFromServiceAccountEmail(this.#serviceAccount);
  }

  /**
   * extractProjectIDFromServiceAccountEmail extracts the project ID from the
   * service account email address.
   */
  extractProjectIDFromServiceAccountEmail(str: string): string {
    if (!str) {
      return '';
    }

    const [, dn] = str.split('@', 2);
    if (!str.endsWith('.iam.gserviceaccount.com')) {
      throw new Error(
        `Service account email ${str} is not of the form ` +
          `"[name]@[project].iam.gserviceaccount.com. You must manually ` +
          `specify the "project_id" parameter in your GitHub Actions workflow.`,
      );
    }

    const [project] = dn.split('.', 2);
    return project;
  }

  /**
   * getAuthToken generates a Google Cloud federated token using the provided OIDC
   * token and Workload Identity Provider.
   */
  async getAuthToken(): Promise<string> {
    const stsURL = new URL('https://sts.googleapis.com/v1/token');

    const data = {
      audience: '//iam.googleapis.com/' + this.#providerID,
      grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
      requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
      subjectToken: this.#token,
    };

    const opts = {
      hostname: stsURL.hostname,
      port: stsURL.port,
      path: stsURL.pathname + stsURL.search,
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
    };

    try {
      const resp = await BaseClient.request(opts, JSON.stringify(data));
      const parsed = JSON.parse(resp);
      return parsed['access_token'];
    } catch (err) {
      throw new Error(
        `Failed to generate Google Cloud federated token for ${this.#providerID}: ${err}`,
      );
    }
  }

  /**
   * getProjectID returns the project ID. If an override was given, the override
   * is returned. Otherwise, this will be the project ID that was extracted from
   * the service account key JSON.
   */
  async getProjectID(): Promise<string> {
    return this.#projectID;
  }

  /**
   * getServiceAccount returns the service account email for the authentication,
   * extracted from the input parameter.
   */
  async getServiceAccount(): Promise<string> {
    return this.#serviceAccount;
  }

  /**
   * createCredentialsFile creates a Google Cloud credentials file that can be
   * set as GOOGLE_APPLICATION_CREDENTIALS for gcloud and client libraries.
   */
  async createCredentialsFile(outputDir: string): Promise<string> {
    // Extract the request token and request URL from the environment. These
    // are only set when an id-token is requested and the submitter has
    // collaborator permissions.
    const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    const requestURLRaw = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    if (!requestToken || !requestURLRaw) {
      throw new Error(
        'GitHub Actions did not inject $ACTIONS_ID_TOKEN_REQUEST_TOKEN or ' +
          '$ACTIONS_ID_TOKEN_REQUEST_URL into this job. This most likely ' +
          'means the GitHub Actions workflow permissions are incorrect, or ' +
          'this job is being run from a fork. For more information, please ' +
          'see the GitHub documentation at https://docs.github.com/en/actions/security-guides/automatic-token-authentication#permissions-for-the-github_token',
      );
    }
    const requestURL = new URL(requestURLRaw);

    // Append the audience value to the request.
    const params = requestURL.searchParams;
    params.set('audience', this.#audience);
    requestURL.search = params.toString();
    const data = {
      type: 'external_account',
      audience: `//iam.googleapis.com/${this.#providerID}`,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      token_url: 'https://sts.googleapis.com/v1/token',
      service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${
        this.#serviceAccount
      }:generateAccessToken`,
      credential_source: {
        url: requestURL,
        headers: {
          Authorization: `Bearer ${requestToken}`,
        },
        format: {
          type: 'json',
          subject_token_field_name: 'value',
        },
      },
    };

    return await writeSecureFile(outputDir, JSON.stringify(data));
  }
}