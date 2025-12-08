// Kong Gateway management controller
import kongClient from '../utils/kongClient.js';

// Services
export const getServices = async (req, res) => {
  try {
    const response = await kongClient.getServices();
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching Kong services:', error);
    res.status(500).json({ error: 'Failed to fetch services' });
  }
};

export const getService = async (req, res) => {
  try {
    const response = await kongClient.getService(req.params.id);
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching Kong service:', error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || 'Failed to fetch service'
    });
  }
};

export const createService = async (req, res) => {
  try {
    const response = await kongClient.createService(req.body);
    res.status(201).json(response.data);
  } catch (error) {
    console.error('Error creating Kong service:', error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || 'Failed to create service'
    });
  }
};

export const updateService = async (req, res) => {
  try {
    const response = await kongClient.updateService(req.params.id, req.body);
    res.json(response.data);
  } catch (error) {
    console.error('Error updating Kong service:', error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || 'Failed to update service'
    });
  }
};

export const deleteService = async (req, res) => {
  try {
    await kongClient.deleteService(req.params.id);
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting Kong service:', error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || 'Failed to delete service'
    });
  }
};

// Routes
export const getRoutes = async (req, res) => {
  try {
    const response = await kongClient.getRoutes();
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching Kong routes:', error);
    res.status(500).json({ error: 'Failed to fetch routes' });
  }
};

export const getRoute = async (req, res) => {
  try {
    const response = await kongClient.getRoute(req.params.id);
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching Kong route:', error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || 'Failed to fetch route'
    });
  }
};

export const getServiceRoutes = async (req, res) => {
  try {
    const response = await kongClient.getServiceRoutes(req.params.serviceId);
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching service routes:', error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || 'Failed to fetch service routes'
    });
  }
};

export const createRoute = async (req, res) => {
  try {
    const { serviceId } = req.params;
    const response = await kongClient.createRoute(serviceId, req.body);
    res.status(201).json(response.data);
  } catch (error) {
    console.error('Error creating Kong route:', error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || 'Failed to create route'
    });
  }
};

export const updateRoute = async (req, res) => {
  try {
    const response = await kongClient.updateRoute(req.params.id, req.body);
    res.json(response.data);
  } catch (error) {
    console.error('Error updating Kong route:', error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || 'Failed to update route'
    });
  }
};

export const deleteRoute = async (req, res) => {
  try {
    await kongClient.deleteRoute(req.params.id);
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting Kong route:', error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || 'Failed to delete route'
    });
  }
};

// Plugins
export const getPlugins = async (req, res) => {
  try {
    const response = await kongClient.getPlugins();
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching Kong plugins:', error);
    res.status(500).json({ error: 'Failed to fetch plugins' });
  }
};

export const getPlugin = async (req, res) => {
  try {
    const response = await kongClient.getPlugin(req.params.id);
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching Kong plugin:', error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || 'Failed to fetch plugin'
    });
  }
};

export const createPlugin = async (req, res) => {
  try {
    const response = await kongClient.createPlugin(req.body);
    res.status(201).json(response.data);
  } catch (error) {
    console.error('Error creating Kong plugin:', error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || 'Failed to create plugin'
    });
  }
};

export const updatePlugin = async (req, res) => {
  try {
    const response = await kongClient.updatePlugin(req.params.id, req.body);
    res.json(response.data);
  } catch (error) {
    console.error('Error updating Kong plugin:', error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || 'Failed to update plugin'
    });
  }
};

export const deletePlugin = async (req, res) => {
  try {
    await kongClient.deletePlugin(req.params.id);
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting Kong plugin:', error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || 'Failed to delete plugin'
    });
  }
};

// Consumers
export const getConsumers = async (req, res) => {
  try {
    const response = await kongClient.getConsumers();
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching Kong consumers:', error);
    res.status(500).json({ error: 'Failed to fetch consumers' });
  }
};

export const getConsumer = async (req, res) => {
  try {
    const response = await kongClient.getConsumer(req.params.id);
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching Kong consumer:', error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || 'Failed to fetch consumer'
    });
  }
};

export const createConsumer = async (req, res) => {
  try {
    const response = await kongClient.createConsumer(req.body);
    res.status(201).json(response.data);
  } catch (error) {
    console.error('Error creating Kong consumer:', error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || 'Failed to create consumer'
    });
  }
};

export const deleteConsumer = async (req, res) => {
  try {
    await kongClient.deleteConsumer(req.params.id);
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting Kong consumer:', error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || 'Failed to delete consumer'
    });
  }
};

// Upstreams
export const getUpstreams = async (req, res) => {
  try {
    const response = await kongClient.getUpstreams();
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching Kong upstreams:', error);
    res.status(500).json({ error: 'Failed to fetch upstreams' });
  }
};

export const getUpstream = async (req, res) => {
  try {
    const response = await kongClient.getUpstream(req.params.id);
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching Kong upstream:', error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || 'Failed to fetch upstream'
    });
  }
};

export const createUpstream = async (req, res) => {
  try {
    const response = await kongClient.createUpstream(req.body);
    res.status(201).json(response.data);
  } catch (error) {
    console.error('Error creating Kong upstream:', error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || 'Failed to create upstream'
    });
  }
};

export const updateUpstream = async (req, res) => {
  try {
    const response = await kongClient.updateUpstream(req.params.id, req.body);
    res.json(response.data);
  } catch (error) {
    console.error('Error updating Kong upstream:', error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || 'Failed to update upstream'
    });
  }
};

export const deleteUpstream = async (req, res) => {
  try {
    await kongClient.deleteUpstream(req.params.id);
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting Kong upstream:', error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || 'Failed to delete upstream'
    });
  }
};

// Targets
export const getTargets = async (req, res) => {
  try {
    const response = await kongClient.getTargets(req.params.upstreamId);
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching Kong targets:', error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || 'Failed to fetch targets'
    });
  }
};

export const createTarget = async (req, res) => {
  try {
    const response = await kongClient.createTarget(req.params.upstreamId, req.body);
    res.status(201).json(response.data);
  } catch (error) {
    console.error('Error creating Kong target:', error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || 'Failed to create target'
    });
  }
};

export const deleteTarget = async (req, res) => {
  try {
    await kongClient.deleteTarget(req.params.upstreamId, req.params.targetId);
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting Kong target:', error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || 'Failed to delete target'
    });
  }
};

// Certificates
export const getCertificates = async (req, res) => {
  try {
    const response = await kongClient.getCertificates();
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching Kong certificates:', error);
    res.status(500).json({ error: 'Failed to fetch certificates' });
  }
};

export const getCertificate = async (req, res) => {
  try {
    const response = await kongClient.getCertificate(req.params.id);
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching Kong certificate:', error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || 'Failed to fetch certificate'
    });
  }
};

export const createCertificate = async (req, res) => {
  try {
    const response = await kongClient.createCertificate(req.body);
    res.status(201).json(response.data);
  } catch (error) {
    console.error('Error creating Kong certificate:', error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || 'Failed to create certificate'
    });
  }
};

export const deleteCertificate = async (req, res) => {
  try {
    await kongClient.deleteCertificate(req.params.id);
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting Kong certificate:', error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || 'Failed to delete certificate'
    });
  }
};

// SNIs
export const getSNIs = async (req, res) => {
  try {
    const response = await kongClient.getSNIs();
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching Kong SNIs:', error);
    res.status(500).json({ error: 'Failed to fetch SNIs' });
  }
};

export const createSNI = async (req, res) => {
  try {
    const response = await kongClient.createSNI(req.body);
    res.status(201).json(response.data);
  } catch (error) {
    console.error('Error creating Kong SNI:', error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || 'Failed to create SNI'
    });
  }
};

export const deleteSNI = async (req, res) => {
  try {
    await kongClient.deleteSNI(req.params.id);
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting Kong SNI:', error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || 'Failed to delete SNI'
    });
  }
};

// Status
export const getStatus = async (req, res) => {
  try {
    const response = await kongClient.getStatus();
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching Kong status:', error);
    res.status(500).json({ error: 'Failed to fetch Kong status' });
  }
};
