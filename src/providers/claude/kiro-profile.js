export const KIRO_BUILDER_ID_FALLBACK_PROFILE_ARN =
    'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX';

export function isKiroBuilderIdAuth(authMethod) {
    const normalized = String(authMethod || '').toLowerCase().replace(/[_\s]/g, '-');
    return normalized === 'builder-id' || normalized === 'builderid';
}

/**
 * Builder ID has no discoverable profile, but Kiro's q.* streaming endpoint
 * currently requires the fixed ARN used by the official client. Keep it
 * request-local: it is a routing placeholder, not an account profile.
 */
export function resolveKiroRequestProfileArn(authMethod, profileArn) {
    if (typeof profileArn === 'string' && profileArn.trim() !== '') {
        return profileArn;
    }
    if (isKiroBuilderIdAuth(authMethod)) {
        return KIRO_BUILDER_ID_FALLBACK_PROFILE_ARN;
    }
    return profileArn;
}

/**
 * Some CodeWhisperer deployments reject the Builder ID placeholder even though
 * q.* requires it. A 403 from q.* is safe to retry before a stream starts by
 * switching to CodeWhisperer and omitting the placeholder.
 */
export function shouldRetryBuilderWithoutProfile({ authMethod, profileArn, status, requestUrl }) {
    if (!isKiroBuilderIdAuth(authMethod) ||
        profileArn !== KIRO_BUILDER_ID_FALLBACK_PROFILE_ARN ||
        status !== 403) {
        return false;
    }

    try {
        const url = new URL(requestUrl);
        return /^q\.[a-z0-9-]+\.amazonaws\.com$/i.test(url.hostname) &&
            url.pathname.toLowerCase() === '/generateassistantresponse';
    } catch {
        return false;
    }
}
