export const SIMULATION_SHADER = /* wgsl */ `
struct Grid {
    cells: array<atomic<u32>>,
};

struct Uniforms {
    width: u32,
    height: u32,
    frame: u32,
};

@group(0) @binding(0) var<storage, read_write> current: Grid;
@group(0) @binding(1) var<storage, read_write> next: Grid;
@group(0) @binding(2) var<uniform> u: Uniforms;

fn get_idx(x: u32, y: u32) -> u32 {
    return y * u.width + x;
}

// Pseudo-random helper to prevent bias
fn random(n: u32) -> u32 {
    var state = n;
    state = state ^ 2747636419u;
    state = state * 2654435769u;
    state = state ^ (state >> 16u);
    state = state * 2654435769u;
    state = state ^ (state >> 16u);
    state = state * 2654435769u;
    return state;
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let x = global_id.x;
    let y = global_id.y;

    if (x >= u.width || y >= u.height) {
        return;
    }

    let index = get_idx(x, y);
    // Load state from current grid (atomic load required by type, but we treat as read)
    let state = atomicLoad(&current.cells[index]);

    // If empty, nothing to simulate
    if (state == 0u) {
        return;
    }

    // --- PHYSICS RULES ---
    // Rule 1: Down
    // Rule 2: Down-Right
    // Rule 3: Down-Left
    // Using Atomic Compare Exchange on 'next' grid to claim spots.

    let down_y = y + 1u;
    
    // Bottom boundary check
    if (down_y >= u.height) {
        // Hit floor, stay put.
        // We write to 'next' at current position.
        // Since we are occupying 'current' at this position, no one else can move IN here.
        // So we don't need CAS, just Store.
        atomicStore(&next.cells[index], state);
        return;
    }

    // 1. Try Move Down
    let idx_down = get_idx(x, down_y);
    let state_down = atomicLoad(&current.cells[idx_down]);

    if (state_down == 0u) {
        // Target is empty in current frame. Try to claim in next frame.
        // atomicCompareExchangeWeak(ptr, compare, value)
        let res = atomicCompareExchangeWeak(&next.cells[idx_down], 0u, state);
        if (res.exchanged) {
            // Success! We moved.
            return;
        }
        // Failed: Someone else claimed it. Continue to other rules.
    }

    // Randomize Left/Right check order to prevent stacking bias
    let rand = random(index + u.frame);
    let check_right_first = (rand % 2u) == 0u;

    if (check_right_first) {
        // Try Right Diagonal first
        if (x + 1u < u.width) {
            let idx_dr = get_idx(x + 1u, down_y);
            let state_dr = atomicLoad(&current.cells[idx_dr]);
            if (state_dr == 0u) {
                let res = atomicCompareExchangeWeak(&next.cells[idx_dr], 0u, state);
                if (res.exchanged) { return; }
            }
        }
        // Then Left Diagonal
        if (x > 0u) {
            let idx_dl = get_idx(x - 1u, down_y);
            let state_dl = atomicLoad(&current.cells[idx_dl]);
            if (state_dl == 0u) {
                let res = atomicCompareExchangeWeak(&next.cells[idx_dl], 0u, state);
                if (res.exchanged) { return; }
            }
        }
    } else {
        // Try Left Diagonal first
        if (x > 0u) {
            let idx_dl = get_idx(x - 1u, down_y);
            let state_dl = atomicLoad(&current.cells[idx_dl]);
            if (state_dl == 0u) {
                let res = atomicCompareExchangeWeak(&next.cells[idx_dl], 0u, state);
                if (res.exchanged) { return; }
            }
        }
        // Then Right Diagonal
        if (x + 1u < u.width) {
            let idx_dr = get_idx(x + 1u, down_y);
            let state_dr = atomicLoad(&current.cells[idx_dr]);
            if (state_dr == 0u) {
                let res = atomicCompareExchangeWeak(&next.cells[idx_dr], 0u, state);
                if (res.exchanged) { return; }
            }
        }
    }

    // If we are here, all moves failed (blocked or claimed).
    // Stay in place.
    atomicStore(&next.cells[index], state);
}
`;

export const RENDER_SHADER = /* wgsl */ `
struct Grid {
    cells: array<u32>,
};

struct Uniforms {
    width: u32,
    height: u32,
    frame: u32,
};

@group(0) @binding(0) var<storage, read> grid: Grid;
@group(0) @binding(1) var<uniform> u: Uniforms;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var pos = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(1.0, -1.0),
        vec2<f32>(-1.0, 1.0),
        vec2<f32>(-1.0, 1.0),
        vec2<f32>(1.0, -1.0),
        vec2<f32>(1.0, 1.0)
    );

    var output: VertexOutput;
    output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
    // Convert -1..1 to 0..1, flip Y because canvas Y is down but clip space Y is up
    output.uv = pos[vertexIndex] * 0.5 + 0.5;
    output.uv.y = 1.0 - output.uv.y; 
    return output;
}

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let x = u32(uv.x * f32(u.width));
    let y = u32(uv.y * f32(u.height));

    let index = y * u.width + x;
    let state = grid.cells[index];

    if (state > 0u) {
        // Sand Color
        // Vary slightly based on position for visual flair
        let variation = f32((x ^ y) % 10u) / 100.0;
        return vec4<f32>(0.9 + variation, 0.7 + variation, 0.2, 1.0);
    }

    return vec4<f32>(0.05, 0.05, 0.05, 1.0); // Background
}
`;

// Simple compute shader to clear the grid
export const CLEAR_SHADER = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> grid: array<atomic<u32>>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let index = global_id.x;
    if (index >= arrayLength(&grid)) { return; }
    atomicStore(&grid[index], 0u);
}
`;

export const INPUT_SHADER = /* wgsl */ `
struct InputData {
    indices: array<u32>,
};
struct Grid {
    cells: array<atomic<u32>>,
};
@group(0) @binding(0) var<storage, read> inputs: InputData;
@group(0) @binding(1) var<storage, read_write> grid: Grid;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let i = global_id.x;
    // We can't know the length easily without a uniform or max size.
    // We'll rely on dispatch size.
    let idx = inputs.indices[i];
    atomicStore(&grid.cells[idx], 1u);
}
`;