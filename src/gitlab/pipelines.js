import _ from 'lodash'
import {gitlabRequest} from './client'

export async function fetchLatestPipelines(projectId, gitlab) {
  const pipelines = await fetchLatestAndMasterPipeline(projectId, gitlab)

  return Promise.all(pipelines.map(async ({id, ref, status}) => {
    const {commit, stages} = await fetchJobs(projectId, id, gitlab)
    const downstreamStages = await fetchDownstreamJobs(projectId, id, gitlab)
    return {
      id,
      ref,
      status,
      commit,
      stages: stages.concat(downstreamStages)
    }
  }))
}

// eslint-disable-next-line max-statements
async function fetchLatestAndMasterPipeline(projectId, config) {
  const pipelines = await fetchPipelines(projectId, config, {per_page: 100})
  if (pipelines.length === 0) {
    return []
  }
  const latestPipeline = _.take(pipelines, config.numberOfPipelines)
  if (latestPipeline[0].ref === 'master') {
    return latestPipeline
  }
  const latestMasterPipeline = _(pipelines).filter({ref: 'master'}).take(config.numberOfPipelines).value()
  if (latestMasterPipeline.length > 0) {
    return latestPipeline.concat(latestMasterPipeline)
  }
  const masterPipelines = await fetchPipelines(projectId, config, {per_page: 50, ref: 'master'})
  return latestPipeline.concat(0, 10)
}

async function fetchPipelines(projectId, config, options) {
  const {data: pipelines} = await gitlabRequest(`/projects/${projectId}/pipelines`, options, config)
  return pipelines.filter(pipeline => pipeline.status !== 'skipped')
}

async function fetchDownstreamJobs(projectId, pipelineId, config) {
  const {data: gitlabBridgeJobs} = await gitlabRequest(`/projects/${projectId}/pipelines/${pipelineId}/bridges`, {per_page: 100}, config)
  const childPipelines = gitlabBridgeJobs.filter(bridge => bridge.downstream_pipeline.status !== 'skipped')

  const downstreamStages = []
  for(const childPipeline of childPipelines) {
    const {stages} = await fetchJobs(projectId, childPipeline.downstream_pipeline.id, config)
    downstreamStages.push(stages.map(stage => ({
      ...stage,
      name: `${childPipeline.stage}:${stage.name}`
    })))
  }
  return downstreamStages.flat()
}

async function fetchJobs(projectId, pipelineId, config) {
  const {data: gitlabJobs} = await gitlabRequest(`/projects/${projectId}/pipelines/${pipelineId}/jobs?include_retried=true`, {per_page: 100}, config)
  if (gitlabJobs.length === 0) {
    return {}
  }

  const commit = findCommit(gitlabJobs)
  const stages = _(gitlabJobs)
    .map(job => ({
      id: job.id,
      status: job.status,
      stage: job.stage,
      name: job.name,
      startedAt: job.started_at,
      finishedAt: job.finished_at,
      url: job.web_url
    }))
    .orderBy('id')
    .groupBy('stage')
    .mapValues(mergeRetriedJobs)
    .mapValues(cleanup)
    .toPairs()
    .map(([name, jobs]) => ({name, jobs: _.sortBy(jobs, 'name')}))
    .value()

  return {
    commit,
    stages
  }
}

function findCommit(jobs) {
  const [job] = jobs.filter(j => j.commit)
  if (!job) {
    return null
  }
  return {
    title: job.commit.title,
    author: job.commit.author_name
  }
}

function mergeRetriedJobs(jobs) {
  return jobs.reduce((mergedJobs, job) => {
    const index = mergedJobs.findIndex(mergedJob => mergedJob.name === job.name)
    if (index >= 0) {
      mergedJobs[index] = job
    } else {
      mergedJobs.push(job)
    }
    return mergedJobs
  }, [])
}

function cleanup(jobs) {
  return _(jobs)
    .map(job => _.omitBy(job, _.isNull))
    .map(job => _.omit(job, 'stage'))
    .value()
}
