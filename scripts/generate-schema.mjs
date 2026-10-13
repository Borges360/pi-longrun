import {mkdir,writeFile} from 'node:fs/promises';
import {CommonConfigSchema} from '../dist/common/config.js';
await mkdir('schemas',{recursive:true});
await writeFile('schemas/config.schema.json',JSON.stringify({$schema:'https://json-schema.org/draft/2020-12/schema',...CommonConfigSchema},null,2)+'\n');
const string={type:'string'};
await writeFile('schemas/event.schema.json',JSON.stringify({$schema:'https://json-schema.org/draft/2020-12/schema',title:'PiExtensionEventV1',type:'object',additionalProperties:false,required:['schemaVersion','eventId','eventType','source','correlationId','emittedAt','payload'],properties:{schemaVersion:{const:1},eventId:string,eventType:string,source:string,correlationId:string,taskId:string,runId:string,projectKey:string,emittedAt:{type:'string',format:'date-time'},payload:{}}},null,2)+'\n');
