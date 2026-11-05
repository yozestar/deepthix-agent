/**
 * Manifest flattening utilities — shared between the extension host, Vite build
 * scripts, and future standalone backend.
 *
 * Recursively flattens furniture manifest trees into flat asset arrays.
 */
/**
 * Recursively flatten a manifest node into FurnitureAsset[].
 * Inherited properties flow from root to all leaf assets.
 */
export function flattenManifest(node, inherited) {
    if (node.type === 'asset') {
        const asset = node;
        // Merge orientation: node-level takes priority, then inherited
        const orientation = asset.orientation ?? inherited.orientation;
        const state = asset.state ?? inherited.state;
        return [
            {
                id: asset.id,
                name: inherited.name,
                label: inherited.name,
                category: inherited.category,
                file: asset.file,
                width: asset.width,
                height: asset.height,
                footprintW: asset.footprintW,
                footprintH: asset.footprintH,
                isDesk: inherited.category === 'desks',
                canPlaceOnWalls: inherited.canPlaceOnWalls,
                canPlaceOnSurfaces: inherited.canPlaceOnSurfaces,
                backgroundTiles: inherited.backgroundTiles,
                groupId: inherited.groupId,
                ...(orientation ? { orientation } : {}),
                ...(state ? { state } : {}),
                ...(asset.mirrorSide ? { mirrorSide: true } : {}),
                ...(inherited.rotationScheme ? { rotationScheme: inherited.rotationScheme } : {}),
                ...(inherited.animationGroup ? { animationGroup: inherited.animationGroup } : {}),
                ...(asset.frame !== undefined ? { frame: asset.frame } : {}),
            },
        ];
    }
    // Group node
    const group = node;
    const results = [];
    for (const member of group.members) {
        // Build inherited props for children
        const childProps = { ...inherited };
        if (group.groupType === 'rotation') {
            // Rotation groups set groupId and pass rotationScheme
            if (group.rotationScheme) {
                childProps.rotationScheme = group.rotationScheme;
            }
        }
        if (group.groupType === 'state') {
            // State groups propagate orientation from the group level
            if (group.orientation) {
                childProps.orientation = group.orientation;
            }
            // Propagate state from group level if set (for animation groups nested in state)
            if (group.state) {
                childProps.state = group.state;
            }
        }
        if (group.groupType === 'animation') {
            // Animation groups: create animation group ID and propagate state
            // Use the parent's orientation to build a unique animation group name
            const orient = group.orientation ?? inherited.orientation ?? '';
            const st = group.state ?? inherited.state ?? '';
            childProps.animationGroup = `${inherited.groupId}_${orient}_${st}`.toUpperCase();
            if (group.state) {
                childProps.state = group.state;
            }
        }
        // Propagate orientation from group to children (for state groups that have orientation)
        if (group.orientation && !childProps.orientation) {
            childProps.orientation = group.orientation;
        }
        results.push(...flattenManifest(member, childProps));
    }
    return results;
}
//# sourceMappingURL=manifestUtils.js.map