function validRect(rect) {
  return rect && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) && rect.width > 0 && rect.height > 0;
}

function explicitlyHidden(node) {
  return node?.visibleToUser === false || node?.visible === false || node?.hidden === true || node?.isHidden === true;
}

function visibleLabel(snapshot, nativeOracle, label) {
  if (!Array.isArray(snapshot?.nodes)) return false;
  return snapshot.nodes.some(node => {
    if (node?.label !== label || explicitlyHidden(node)) return false;
    if (node.visibleToUser === true) return true;
    // This fallback is specific to our controlled native fixture, whose endpoint
    // has no overlays. Native label evidence is required; bounds alone are not visibility.
    if (node.visibleToUser != null || snapshot.appBundleId !== 'local.jev.benchmark' || !Array.isArray(nativeOracle.visibleLabels) || !nativeOracle.visibleLabels.includes(label)) return false;
    const app = snapshot.nodes.find(candidate => candidate?.type === 'Application');
    if (!app || explicitlyHidden(app) || !validRect(app.rect) || !validRect(node.rect)) return false;
    const outer = app.rect;
    const inner = node.rect;
    return inner.x >= outer.x && inner.y >= outer.y &&
      inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
  });
}

/** Independent fixture checks at the verdict and after execution. */
export function evaluateOracle({ scenario, spec, terminalSnapshot, finalSnapshot, terminalOracle, oracle } = {}) {
  if (!spec || typeof spec.screen !== 'string' || !spec.screen || !Array.isArray(spec.events)) return false;
  const labels = spec.labels ?? [spec.label];
  if (!Array.isArray(labels) || !labels.length || !labels.every(label => typeof label === 'string' && label.length > 0)) return false;
  return [[terminalSnapshot, terminalOracle], [finalSnapshot, oracle]].every(([snapshot, evidence]) => {
    if (!evidence || evidence.screen !== spec.screen || !Array.isArray(evidence.events)) return false;
    if (evidence.events.length !== spec.events.length || !spec.events.every((event, index) => typeof event === 'string' && event === evidence.events[index])) return false;
    if (!labels.every(label => visibleLabel(snapshot, evidence, label))) return false;
    return scenario !== 'form' || (evidence.values?.Name === 'Ada' && evidence.values?.Email === 'ada@example.com');
  });
}
