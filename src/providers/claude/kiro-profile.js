export function isKiroBuilderIdAuth(authMethod) {
    const normalized = String(authMethod || '').toLowerCase().replace(/[_\s]/g, '-');
    return normalized === 'builder-id' || normalized === 'builderid';
}

/**
 * Builder ID has no discoverable profile. Keep any real profile supplied by
 * the credential, but never manufacture or persist a placeholder ARN.
 */
export function resolveKiroRequestProfileArn(authMethod, profileArn) {
    if (typeof profileArn === 'string' && profileArn.trim() !== '') {
        return profileArn;
    }
    if (isKiroBuilderIdAuth(authMethod)) {
        return undefined;
    }
    return profileArn;
}

/**
 * The q.* generation endpoint can require profileArn, while the legacy
 * CodeWhisperer endpoint accepts Builder ID without one. Route only profileless
 * Builder ID requests; credentials with a real profile keep the normal route.
 */
export function shouldRouteBuilderToCodeWhisperer({ authMethod, profileArn, requestUrl }) {
    if (!isKiroBuilderIdAuth(authMethod) ||
        (typeof profileArn === 'string' && profileArn.trim() !== '')) {
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
