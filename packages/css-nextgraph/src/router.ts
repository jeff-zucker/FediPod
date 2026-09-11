// router.ts — the one routing decision this backend needs: the server's own
// `.internal/` records (accounts, sign-up state, keys) under the base URL go
// to one store, every pod resource, on whatever origin, to the other. CSS's
// RegexRouterRule cannot do it: it refuses identifiers outside the base URL,
// which is every subdomain pod.
import { RouterRule, ensureTrailingSlash } from '@solid/community-server';
import type { Representation, ResourceIdentifier, ResourceStore } from '@solid/community-server';

export interface InternalRouterRuleArgs {
  /** The server's base URL. */
  baseUrl: string;
  /** Where `<baseUrl>.internal/` goes. */
  internalStore: ResourceStore;
  /** Where everything else goes. */
  podStore: ResourceStore;
}

export class InternalRouterRule extends RouterRule {
  private readonly internalPrefix: string;

  public constructor(private readonly args: InternalRouterRuleArgs) {
    super();
    this.internalPrefix = `${ensureTrailingSlash(args.baseUrl)}.internal/`;
  }

  public async handle(input: { identifier: ResourceIdentifier; representation?: Representation }): Promise<ResourceStore> {
    return input.identifier.path.startsWith(this.internalPrefix) ? this.args.internalStore : this.args.podStore;
  }
}
