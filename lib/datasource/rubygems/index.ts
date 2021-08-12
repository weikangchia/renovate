import urlJoin from 'url-join';
import { logger } from '../../logger';
import { ExternalHostError } from '../../types/errors/external-host-error';
import { getElapsedMinutes } from '../../util/date';
import { OutgoingHttpHeaders } from '../../util/http/types';
import * as rubyVersioning from '../../versioning/ruby';
import { Datasource } from '../datasource';
import { GetReleasesConfig, ReleaseResult } from '../types';

const INFO_PATH = '/api/v1/gems';
const VERSIONS_PATH = '/api/v1/versions';

let lastSync = new Date('2000-01-01');
let packageReleases: Record<string, string[]> = Object.create(null); // Because we might need a "constructor" key
let contentLength = 0;
let updateRubyGemsVersionsPromise: Promise<void> | undefined;

// Note: use only for tests
export function resetCache(): void {
  lastSync = new Date('2000-01-01');
  packageReleases = Object.create(null);
  contentLength = 0;
}

export class RubyGemsDatasource extends Datasource {
  public static id = 'rubygems';

  constructor() {
    super(RubyGemsDatasource.id);
  }

  override readonly defaultRegistryUrls = ['https://rubygems.org'];

  override readonly defaultVersioning = rubyVersioning.id;

  override readonly registryStrategy = 'hunt';

  getReleases({
    lookupName,
    registryUrl,
  }: GetReleasesConfig): Promise<ReleaseResult | null> {
    // prettier-ignore
    if (registryUrl.endsWith('rubygems.org')) { // lgtm [js/incomplete-url-substring-sanitization]
      return this.getRubygemsOrgDependency(lookupName);
    }
    return this.getDependency(lookupName, registryUrl);
  }

  private async getRubygemsOrgDependency(
    lookupName: string
  ): Promise<ReleaseResult | null> {
    logger.debug(`getRubygemsOrgDependency(${lookupName})`);
    await this.syncVersions();
    if (!packageReleases[lookupName]) {
      return null;
    }
    const dep: ReleaseResult = {
      releases: packageReleases[lookupName].map((version) => ({
        version,
      })),
    };
    return dep;
  }

  async getDependency(
    dependency: string,
    registry: string
  ): Promise<ReleaseResult | null> {
    logger.debug({ dependency }, 'RubyGems lookup for dependency');
    const info = await this.fetch(dependency, registry, INFO_PATH);
    if (!info) {
      logger.debug({ dependency }, 'RubyGems package not found.');
      return null;
    }

    if (dependency.toLowerCase() !== info.name.toLowerCase()) {
      logger.warn(
        { lookup: dependency, returned: info.name },
        'Lookup name does not match with returned.'
      );
      return null;
    }

    let versions = [];
    let releases = [];
    try {
      versions = await this.fetch(dependency, registry, VERSIONS_PATH);
    } catch (err) {
      if (err.statusCode === 400 || err.statusCode === 404) {
        logger.debug(
          { registry },
          'versions endpoint returns error - falling back to info endpoint'
        );
      } else {
        throw err;
      }
    }

    if (versions.length === 0 && info.version) {
      logger.warn('falling back to the version from the info endpoint');
      releases = [
        {
          version: info.version,
          rubyPlatform: info.platform,
        },
      ];
    } else {
      releases = versions.map(
        ({
          number: version,
          platform: rubyPlatform,
          created_at: releaseTimestamp,
          rubygems_version: rubygemsVersion,
          ruby_version: rubyVersion,
        }) => ({
          version,
          rubyPlatform,
          releaseTimestamp,
          rubygemsVersion,
          rubyVersion,
        })
      );
    }

    return {
      releases,
      homepage: info.homepage_uri,
      sourceUrl: info.source_code_uri,
      changelogUrl: info.changelog_uri,
    };
  }

  /* https://bugs.chromium.org/p/v8/issues/detail?id=2869 */
  private static copystr = (x: string): string => (' ' + x).slice(1);

  async updateRubyGemsVersions(): Promise<void> {
    const url = 'https://rubygems.org/versions';
    const options = {
      headers: {
        'accept-encoding': 'identity',
        range: `bytes=${contentLength}-`,
      },
    };
    let newLines: string;
    try {
      logger.debug('Rubygems: Fetching rubygems.org versions');
      const startTime = Date.now();
      newLines = (await this.http.get(url, options)).body;
      const durationMs = Math.round(Date.now() - startTime);
      logger.debug({ durationMs }, 'Rubygems: Fetched rubygems.org versions');
    } catch (err) /* istanbul ignore next */ {
      if (err.statusCode !== 416) {
        contentLength = 0;
        packageReleases = Object.create(null); // Because we might need a "constructor" key
        throw new ExternalHostError(
          new Error('Rubygems fetch error - need to reset cache')
        );
      }
      logger.debug('Rubygems: No update');
      lastSync = new Date();
      return;
    }

    for (const line of newLines.split('\n')) {
      RubyGemsDatasource.processLine(line);
    }
    lastSync = new Date();
  }

  private static processLine(line: string): void {
    let split: string[];
    let pkg: string;
    let versions: string;
    try {
      const l = line.trim();
      if (!l.length || l.startsWith('created_at:') || l === '---') {
        return;
      }
      split = l.split(' ');
      [pkg, versions] = split;
      pkg = RubyGemsDatasource.copystr(pkg);
      packageReleases[pkg] = packageReleases[pkg] || [];
      const lineVersions = versions.split(',').map((version) => version.trim());
      for (const lineVersion of lineVersions) {
        if (lineVersion.startsWith('-')) {
          const deletedVersion = lineVersion.slice(1);
          logger.trace({ pkg, deletedVersion }, 'Rubygems: Deleting version');
          packageReleases[pkg] = packageReleases[pkg].filter(
            (version) => version !== deletedVersion
          );
        } else {
          packageReleases[pkg].push(RubyGemsDatasource.copystr(lineVersion));
        }
      }
    } catch (err) /* istanbul ignore next */ {
      logger.warn(
        { err, line, split, pkg, versions },
        'Rubygems line parsing error'
      );
    }
  }

  private static isDataStale(): boolean {
    return getElapsedMinutes(lastSync) >= 5;
  }

  private async syncVersions(): Promise<void> {
    if (RubyGemsDatasource.isDataStale()) {
      updateRubyGemsVersionsPromise =
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        updateRubyGemsVersionsPromise || this.updateRubyGemsVersions();
      await updateRubyGemsVersionsPromise;
      updateRubyGemsVersionsPromise = null;
    }
  }

  static getHeaders = (): OutgoingHttpHeaders => ({
    hostType: RubyGemsDatasource.id,
  });

  async fetch(
    dependency: string,
    registry: string,
    path: string
  ): Promise<any> {
    const headers = RubyGemsDatasource.getHeaders();

    const url = urlJoin(registry, path, `${dependency}.json`);

    logger.trace({ dependency }, `RubyGems lookup request: ${String(url)}`);
    const response = (await this.http.getJson(url, { headers })) || {
      body: undefined,
    };

    return response.body;
  }
}
