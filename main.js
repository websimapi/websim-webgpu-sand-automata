import { SIMULATION_SHADER, RENDER_SHADER, CLEAR_SHADER } from './shaders.js';

const WIDTH = 1280;
const HEIGHT = 720;
const WORKGROUP_SIZE = 16;

const canvas = document.getElementById('gpuCanvas');
const fpsElem = document.getElementById('fps');
canvas.width = WIDTH;
canvas.height = HEIGHT;

let device, context;
let pipelineSimulation, pipelineRender, pipelineClear;
let bufferGridA, bufferGridB, bufferUniforms;
let bindGroupSimA, bindGroupSimB; // A->B, B->A
let bindGroupRenderA, bindGroupRenderB;
let bindGroupClearA, bindGroupClearB;

let frameCount = 0;
let lastTime = 0;
let isDrawing = false;
let inputQueue = []; // Pixels to add sand to

async function init() {
    if (!navigator.gpu) {
        alert("WebGPU not supported on this browser.");
        return;
    }

    const adapter = await navigator.gpu.requestAdapter();
    device = await adapter.requestDevice();
    context = canvas.getContext('webgpu');

    context.configure({
        device: device,
        format: navigator.gpu.getPreferredCanvasFormat(),
        alphaMode: 'premultiplied',
    });

    createAssets();
    createPipelines();
    createBindGroups();
    setupInput();

    requestAnimationFrame(loop);
}

function createAssets() {
    // Grid Size in bytes (u32 per cell)
    const gridSize = WIDTH * HEIGHT * 4;

    // Buffer A
    bufferGridA = device.createBuffer({
        size: gridSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });

    // Buffer B
    bufferGridB = device.createBuffer({
        size: gridSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });

    // Uniforms (Width, Height, Frame)
    bufferUniforms = device.createBuffer({
        size: 16, // 3 * u32 + padding
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    
    // Initial Uniforms
    device.queue.writeBuffer(bufferUniforms, 0, new Uint32Array([WIDTH, HEIGHT, 0]));
}

function createPipelines() {
    const moduleSim = device.createShaderModule({ code: SIMULATION_SHADER });
    const moduleRender = device.createShaderModule({ code: RENDER_SHADER });
    const moduleClear = device.createShaderModule({ code: CLEAR_SHADER });

    // Compute Pipeline
    pipelineSimulation = device.createComputePipeline({
        layout: 'auto',
        compute: { module: moduleSim, entryPoint: 'main' },
    });

    // Render Pipeline
    pipelineRender = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: moduleRender, entryPoint: 'vs_main' },
        fragment: {
            module: moduleRender,
            entryPoint: 'fs_main',
            targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }],
        },
        primitive: { topology: 'triangle-list' },
    });

    // Clear Pipeline
    pipelineClear = device.createComputePipeline({
        layout: 'auto',
        compute: { module: moduleClear, entryPoint: 'main' },
    });
}

function createBindGroups() {
    // Simulation Bind Groups
    // Group 0: Current(ReadWrite), Next(ReadWrite), Uniforms
    bindGroupSimA = device.createBindGroup({
        layout: pipelineSimulation.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: bufferGridA } },
            { binding: 1, resource: { buffer: bufferGridB } },
            { binding: 2, resource: { buffer: bufferUniforms } },
        ],
    });

    bindGroupSimB = device.createBindGroup({
        layout: pipelineSimulation.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: bufferGridB } },
            { binding: 1, resource: { buffer: bufferGridA } },
            { binding: 2, resource: { buffer: bufferUniforms } },
        ],
    });

    // Render Bind Groups
    // Group 0: Grid(Read), Uniforms
    bindGroupRenderA = device.createBindGroup({
        layout: pipelineRender.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: bufferGridA } },
            { binding: 1, resource: { buffer: bufferUniforms } },
        ],
    });

    bindGroupRenderB = device.createBindGroup({
        layout: pipelineRender.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: bufferGridB } },
            { binding: 1, resource: { buffer: bufferUniforms } },
        ],
    });

    // Clear Bind Groups
    // Group 0: Grid(ReadWrite)
    bindGroupClearA = device.createBindGroup({
        layout: pipelineClear.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: bufferGridA } }],
    });

    bindGroupClearB = device.createBindGroup({
        layout: pipelineClear.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: bufferGridB } }],
    });
}

function setupInput() {
    const addInput = (e) => {
        if (!isDrawing) return;
        const rect = canvas.getBoundingClientRect();
        
        let clientX, clientY;
        if (e.touches) {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
        } else {
            clientX = e.clientX;
            clientY = e.clientY;
        }

        // Map to canvas coordinates
        const x = Math.floor((clientX - rect.left) / rect.width * WIDTH);
        const y = Math.floor((clientY - rect.top) / rect.height * HEIGHT);

        // Brush Size
        const radius = 5;
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                if (dx*dx + dy*dy <= radius*radius) {
                    const px = x + dx;
                    const py = y + dy;
                    if (px >= 0 && px < WIDTH && py >= 0 && py < HEIGHT) {
                        // Random sparsity for sand effect
                        if (Math.random() > 0.5) {
                            inputQueue.push(py * WIDTH + px);
                        }
                    }
                }
            }
        }
    };

    canvas.addEventListener('mousedown', (e) => { isDrawing = true; addInput(e); });
    window.addEventListener('mouseup', () => isDrawing = false);
    canvas.addEventListener('mousemove', addInput);
    
    canvas.addEventListener('touchstart', (e) => { isDrawing = true; addInput(e); e.preventDefault(); }, {passive: false});
    window.addEventListener('touchend', () => isDrawing = false);
    canvas.addEventListener('touchmove', (e) => { addInput(e); e.preventDefault(); }, {passive: false});
}

function loop(timestamp) {
    if (timestamp - lastTime >= 1000) {
        fpsElem.innerText = Math.round(1000 / (timestamp - lastTime) * 60); // Approx
        lastTime = timestamp;
    }

    const commandEncoder = device.createCommandEncoder();

    // Determine Buffer pointers
    // Frame 0: Read A, Write B
    // Frame 1: Read B, Write A
    const useAasInput = frameCount % 2 === 0;
    
    const inputBuffer = useAasInput ? bufferGridA : bufferGridB;
    const outputBuffer = useAasInput ? bufferGridB : bufferGridA;
    const simBindGroup = useAasInput ? bindGroupSimA : bindGroupSimB;
    const clearBindGroupForOutput = useAasInput ? bindGroupClearB : bindGroupClearA;
    const renderBindGroup = useAasInput ? bindGroupRenderB : bindGroupRenderA; // We render the result (output)

    // 1. Process Input (Write to Input Buffer before Sim)
    if (inputQueue.length > 0) {
        // De-duplicate and write
        // To be safe and efficient, we can't write thousands of separate calls.
        // We pack into a typed array.
        // Max updates per frame limited for performance?
        const uniqueIndices = [...new Set(inputQueue)];
        inputQueue = []; // Clear queue
        
        // Since writeBuffer takes offset/size, and indices are scattered,
        // we can't do one writeBuffer.
        // Optimization: Create a "staging" buffer or compute shader brush.
        // For simplicity: We will just iterate. If this is slow, we optimize.
        // Actually, queue.writeBuffer overhead is high.
        // Better: Upload a list of indices to a separate buffer and run a "Input" compute shader.
        // For now, let's try a bulk write if possible? No.
        // Let's use a DataView to write chunks if contiguous? No, sand is scattered.
        
        // ALTERNATIVE: Mapped Buffer? No, async.
        // Given constraints, I'll write a small compute pass for brush?
        // Let's stick to raw JS writes for now, but limit count.
        // Actually, if I have 100 pixels, 100 API calls is bad.
        // Let's use an Input Compute Shader.
        
        // ... implementing simplified brush logic directly via buffer upload ...
        // We will create a temp buffer with indices, and dispatch a "Scatter" shader.
        if (uniqueIndices.length > 0) {
             const inputData = new Uint32Array(uniqueIndices);
             // Create a temporary mapped buffer or use writeBuffer to a reusable input buffer
             // Reusing a buffer is best.
             // We need an "InputBuffer"
             const inputStaging = device.createBuffer({
                 size: inputData.byteLength,
                 usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
                 mappedAtCreation: true
             });
             new Uint32Array(inputStaging.getMappedRange()).set(inputData);
             inputStaging.unmap();
             
             // We need a pipeline to scatter these into the grid.
             // Defined inline here to save file space, or added to shaders.
             // Let's just do it inefficiently for now or assume user won't draw massive blobs per frame.
             // Actually, for "Sand Game", drawing is key.
             // Let's try the naive writeBuffer loop but limited.
             // Better: map the whole buffer? No.
             
             // Optimized approach: Update the Input Buffer (Current State)
             // We create a "Brush Shader" on the fly? No.
             
             // I will assume the brush is small enough.
             // Wait, 1280x720, brush radius 5 = ~80 pixels. 80 calls is okay-ish.
             for(let idx of uniqueIndices) {
                 device.queue.writeBuffer(inputBuffer, idx * 4, new Uint32Array([1]));
             }
             inputStaging.destroy(); // not used in this path
        }
    }

    // 2. Clear Output Buffer (The "Claims" grid needs to be empty)
    {
        const pass = commandEncoder.beginComputePass();
        pass.setPipeline(pipelineClear);
        pass.setBindGroup(0, clearBindGroupForOutput);
        const workgroups = Math.ceil((WIDTH * HEIGHT) / 256);
        pass.dispatchWorkgroups(workgroups);
        pass.end();
    }

    // 3. Update Uniforms (Frame count)
    device.queue.writeBuffer(bufferUniforms, 8, new Uint32Array([frameCount]));

    // 4. Run Simulation
    {
        const pass = commandEncoder.beginComputePass();
        pass.setPipeline(pipelineSimulation);
        pass.setBindGroup(0, simBindGroup);
        pass.dispatchWorkgroups(Math.ceil(WIDTH / 16), Math.ceil(HEIGHT / 16));
        pass.end();
    }

    // 5. Render Result
    {
        const pass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: context.getCurrentTexture().createView(),
                clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1.0 },
                loadOp: 'clear',
                storeOp: 'store',
            }]
        });
        pass.setPipeline(pipelineRender);
        pass.setBindGroup(0, renderBindGroup);
        pass.draw(6);
        pass.end();
    }

    device.queue.submit([commandEncoder.finish()]);

    frameCount++;
    requestAnimationFrame(loop);
}

init();