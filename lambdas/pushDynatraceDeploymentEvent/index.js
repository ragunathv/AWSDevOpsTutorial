var AWS = require('aws-sdk');
var cputils = require('codepipelineutils');
var dtApiUtils = require('dtapiutils');
var monspec = require('monspec');

// This function can handle invocations from CodePipeline as well as other Callers
// When invoked from CodePipeline the event["CodePipeline.job"] value is set and the function assumes mandatory parameters in data.actionConfiguration.configuration.UserParameters
// When invoked through API Gateway the function assumes mandatory parameters to be passed in event.eventBody

// Mandatory Parameters
// dtApiToken: this is the Dynatrace API Token
// dtTenantURL: this is the Dynatrace Tenant URL
// attachRules: The rules for those entities that should get this deployment event -> for details see https://www.dynatrace.com/support/help/dynatrace-api/events/how-do-i-push-events-from-3rd-party-systems/
// eventType: CUSTOM_DEPLOYMENT or CUSTOM_ANNOTATION
// depending on eventType you have to pass the mandatory and optional parameters as described here: https://www.dynatrace.com/support/help/dynatrace-api/events/how-do-i-push-events-from-3rd-party-systems/
// -- CUSTOM_DEPLOYMENT: deploymentName (mandatory), deploymentVersion (optional), deploymentProject (optional) ...
// -- CUSTOM_ANNOTATION: annotationType (mandatory), annotationDescription (optional)
// -- BOTH (optional): source, customProperties

var reportError = function(message, codePipelineJobId, context) {
    if(codePipelineJobId) cputils.putJobFailure(message, codePipelineJobId, context);
    else context.fail(message);
    console.log("Error: " + message);
}

var reportSuccess = function(message, codePipelineJobId, context) {
    if(codePipelineJobId) cputils.putJobSuccess(message, codePipelineJobId, context);
    else context.succeed(message);
    console.log("Success: " + message);
}

// handles the request to create a custom event in Dynatrace
exports.handler = function(event, context, callback) {
    
    dtApiUtils.dtApiInit(function(err,data) {
        
        if(err) {
            console("dtApiInit failed: " + err);
            callback(err, "Execution Failed!")
            return;
        }
        
        var codePipelineJobId = null;    
        var postedData = null;
        
        console.log("Event Data\n");
        console.log(JSON.stringify(event));
        console.log("Context Object\n");
        console.log(JSON.stringify(context));
        
        try {
        
            // lets check if called from CodePipeline
            if(event["CodePipeline.job"]) {
                var job = event["CodePipeline.job"];
                var monspecurl = null;
                codePipelineJobId = job.id;
                console.log("Invoked from CodePipeline with JobId: " + codePipelineJobId)
                
                // Retrieve the value of UserParameters from the Lambda action configuration in AWS CodePipeline
                // It can either be a JSON object or a a comma separated string with <EnvironmentName>,<MonSpec>|<Annotation Description>
                // it can either be a JSON string or simply a description which we  map to a custom annnotation description
                // TODO: also allow a URL to be passed and just parse the monspec file from there!
                if(job.data.actionConfiguration.configuration.UserParameters.startsWith("{")) {
                    postedData = JSON.parse(job.data.actionConfiguration.configuration.UserParameters)
                } else {
                    var userDataConfigs = job.data.actionConfiguration.configuration.UserParameters.split(",");

                    postedData = {};
                    postedData.environmentName = userDataConfigs[0];

                    if((userDataConfigs.length > 1) && userDataConfigs[1].startsWith("http")) {
                        postedData = {};
                        monspecurl = userDataConfigs[1];
                    } else {
                        postedData.userComment = userDataConfigs.length > 1 ? userDataConfigs[1] : job.data.actionConfiguration.configuration.UserParameters
                    }
                }
                
                // retrieve more information about the CodePipeline Job, e.g: CodePipeline Name, ...
                cputils.getJobDetails(codePipelineJobId, true, function(err, jobDetails) {
                    if(err) {callback("Cant retrieve job details from CodePipeline: " + err);return;}
    
                    // if we dont have a type we assume it is just an annotation
                    if(!postedData.eventType) postedData.eventType = jobDetails.codedeploy ? "CUSTOM_DEPLOYMENT" : "CUSTOM_ANNOTATION";
                    
                    // depending on the event type we also sete the the comment as either annotationtype or deploymentname
                    if(postedData.eventType == "CUSTOM_ANNOTATION") {
                        if(!postedData.annotationType) postedData.annotationType = jobDetails.pipelineName;
                        if(postedData.userComment) postedData.annotationDescription = postedData.userComment;
                    }
                    if(postedData.eventType == "CUSTOM_DEPLOYMENT") {
                        if(!postedData.deploymentName) postedData.deploymentName = postedData.userComment ? postedData.userComment : jobDetails.pipelineName;
                        if(!postedData.deploymentVersion) postedData.deploymentVersion = jobDetails.codedeploy ? jobDetails.codedeploy.deploymentId : codePipelineJobId;
                        if(!postedData.deploymentProject) postedData.deploymentProject = jobDetails.pipelineName;
                    }
    
                    // every property in the jobDetails object becomes a custom property as well
                    if(!postedData.customProperties) postedData.customProperties = { "PipelineName" : jobDetails.pipelineName, "PipelineStage" : jobDetails.stage, "PipelineAction" : jobDetails.action};
                    if(jobDetails.codedeploy) {
                        postedData.customProperties["CodeDeploy.DeploymentGroup"] = jobDetails.codedeploy.deploymentGroup;
                        postedData.customProperties["CodeDeploy.Application"] = jobDetails.codedeploy.application;
                        postedData.customProperties["CodeDeploy.DeploymentId"] = jobDetails.codedeploy.deploymentId;
                    }
                   
                    // and if no source is set then the pipeline becomes the source as well
                    if(!postedData.source) postedData.source = "AWS CodePipeline";
                    
                    // if we have an input artificat that links to a monspec file then we look at it for tag information!
                    if(job.data.inputArtifacts && job.data.inputArtifacts[0]) {            
                        // lets download the monspec.json file content
                        cputils.downloadFile(job.data.inputArtifacts[0], job.data.artifactCredentials, monspecurl, function(err, content) {
                            if(err) {
                                cputils.putJobFailure(err, job.id, context);
                                return;
                            }
                            
                            // parse monspec["SERVICENAME"].tags and put it to postedData.attachRules!
                            var monspecobject = JSON.parse(content);
                            var tagRules = monspec.getAllTagRules(monspecobject, postedData.environmentName);
                            if(!postedData.attachRules) postedData.attachRules = { "tagRule" : []};
                            if(!postedData.attachRules.tagRule) postedData.attachRules.tagRule = [];
                            postedData.attachRules.tagRule = postedData.attachRules.tagRule.concat(tagRules);
                            
                            postToApi(postedData, codePipelineJobId, context);
                        });
                    } else {
                        postToApi(postedData, codePipelineJobId, context);
                    }
                });
            } else if(event.Records && event.Records[0]) {
                // Here we handle SNS Notifications - for instance when a notification comes in from CodeDeploy
                // SNS Notifcations provide data in Records[0].Sns.Message
                
                if(event.Records[0].Sns.Message.startsWith("{")) {
                    // here are some sample messages from CodeDeploy
                    // "{\"region\":\"us-east-2\",\"accountId\":\"141102083285\",\"eventTriggerName\":\"DeployPipelineStatusNotification\",\"applicationName\":\"HelloWorld\",\"deploymentId\":\"d-96V3B7QKP\",\"deploymentGroupName\":\"Production\",\"createTime\":\"Fri Jan 19 08:07:10 UTC 2018\",\"completeTime\":null,\"status\":\"CREATED\"}",

                    var notificationData = JSON.parse(event.Records[0].Sns.Message)
                    console.log(event.Records[0].Sns.Message);
                    
                    if(notificationData.deploymentId && notificationData.status && notificationData.status === "CREATED") {
                
                        /*notificationData.applicationName;
                        notificationData.deploymentId;
                        notificationData.deploymentGroupName;
                        notificationData.status;*/
                    }
                }
                
                
            } else 
            {
                postedData = event.eventBody ? event.eventBody : event;
                postToApi(postedData, codePipelineJobId, context);
            }
            

        } catch (error) {
            console.log("ERROR LOG: " + error);
            reportError(error, codePipelineJobId, context);
        }
        
    });

}

var postToApi = function(postedData, codePipelineJobId, context) {
    // log the data we received!
    console.log("Posted Data\n");
    console.log(JSON.stringify(postedData));

    // get our global confiugration via env
    postedData.dtApiToken = postedData.dtApiToken || dtApiUtils.getDtApiToken();
    postedData.dtTenantURL = postedData.dtTenantURL || dtApiUtils.getDtTenantUrl();

    // do manadatory param check
    if(!postedData.dtApiToken)  {reportError("dtApiToken missing", codePipelineJobId); return;}
    if(!postedData.dtTenantURL) {reportError("dtTenantURL missing", codePipelineJobId); return;}
    if(!postedData.attachRules) {reportError("attachRules missing", codePipelineJobId); return;}
    if(!postedData.eventType)   {reportError("eventType missing", codePipelineJobId); return;}
    if(postedData.eventType == "CUSTOM_ANNOTATION") {
        if(!postedData.annotationType)   {reportError("annotationType missing", codePipelineJobId); return;}
    }
    if(postedData.eventType == "CUSTOM_DEPLOYMENT") {
        if(!postedData.deploymentName)   {reportError("deploymentName missing", codePipelineJobId); return;}
    }

    // seems we have our mandatory fields - now lets construct that REST API Call
    var dtEventUrl = postedData.dtTenantURL + "/api/v1/events";
    var event = {
        "start" : Date.now().toString(),
        "end" : Date.now().toString(),
        "source" : postedData.source ? postedData.source : "Dynatrace AWS Lambda",
        "eventType" : postedData.eventType,
        "attachRules" : postedData.attachRules
    }
    
    // passing on all mandatory & optional values
    var properties = ["deploymentName", "deploymentVersion", "deploymentProject", "annotationType", "annotationDescription", "source", "customProperties"];
    for (var prop in properties) {
        var propName = properties[prop];
        if(postedData[propName]) event[propName] = postedData[propName];
    }
    
    // lets log our call to Dynatrace
    console.log("HTTP POST " + dtEventUrl);
    console.log("ApiToken: " + postedData.dtApiToken);
    console.log(JSON.stringify(event));
    
    dtApiUtils.dtApiPost(dtEventUrl, postedData.dtApiToken, event, function(statuscode, response) {
        if(statuscode == 200) {
            reportSuccess("Successfully sent event to Dynatrace", codePipelineJobId, context);
            return;
        }
        
        if(statuscode == 400) {
            // lets do some error analysis. If there are no Entities that match our attachRules we will receive an HTTP 400 with an error message indicating this issue
            // e.g: this comes back in response: {\"error\":{\"code\":400,\"message\":\"Invalid attachRules object provided. No MEIdentifier do match: Matching rule: PushEventAttachRules{entityIds=null, tagRules=[TagMatchRule{meTypes=[SERVICE], tags=[[CONTEXTLESS]DeploymentGroup:Staging]}]}\"}}
            if(response.startsWith("{")) {
                var responseObject = JSON.parse(response);
                if(responseObject.error && responseObject.error.message.includes("No MEIdentifier do match")) {
                    reportError("Failed to push Dynatrace Deployment Event!\nNO Entities found that match your Tags: + " + JSON.stringify(postedData.attachRules) + "\n\nDouble check your tag configuration in monspec or in Dynatrace!", codePipelineJobId, context)
                    return;
                }
            }
        }
        
        reportError("Failed to send event to Dynatrace: " + response, codePipelineJobId, context);
    });    
}