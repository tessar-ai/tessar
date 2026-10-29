
   import assert from 'node:assert/strict';
   import { Agent, Controller, HumanMessage, stream as streamHooks } from '@tessar/core';
   import {ScriptedProvider} from '@tessar/core/testing';
   import {PluginManager} from '@tessar/plugins';
   const manager=new PluginManager({directory:process.argv[1],hostUrl:import.meta.url});
   const original=console.error,logs=[];let controller;
   console.error=line=>{logs.push(JSON.parse(line));};
   try{
    const [logger]=await manager.load();assert.equal(logger.id,'logger');
    const provider=new ScriptedProvider([{text:'logger works'}]);
    const agent=new Agent({id:'logger-host',model:{providerId:'scripted',modelId:'test'}});
    controller=new Controller({id:'logger-controller',agent,plugins:[logger,{id:'provider',setup(tessar){tessar.models.register({id:'scripted',create:()=>provider});}}]});await controller.initialize();
    const result=await agent.generate(new HumanMessage('hello'));
    assert.equal(result.status,'completed');assert.equal(result.output[0].content[0].text,'logger works');
    assert.ok(logs.some(entry=>entry.type===streamHooks.end&&entry.agentId==='logger-host'&&entry.controllerId==='logger-controller'));
   }finally{try{await controller?.dispose();}finally{manager.dispose();console.error=original;}}
  